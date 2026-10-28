import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ageFromDob, EV, GENDERS, isIntent, type ChatMessage, type Gender, type Intent, type PeerView } from "../../contracts";
import type { Db } from "../../db/client";
import { matches, preferences, users } from "../../db/schema";
import type { RedisClient } from "../../lib/redis";
import type { Chat, ChatSide, ChatStore } from "../chat/chat.store";
import type { AppServer } from "../../realtime/context";
import { moderationRepo } from "../moderation/moderation.repo";
import { aiFlagReason, isSevere, type HostileReason } from "./chat.hostility";
import { createDynamicPersona, ensureSystemBotUser, getPersonaById, isBotUserId, pickBotGender, SYSTEM_BOT_USER_ID } from "./persona.service";
import { noDashes } from "./chat.texting";
import { AiChatGuard } from "./ai.chat.guard";
import { ReplyPacer } from "./ai.reply.pacer";
import { pickLine, SKIP_GOODBYES } from "./chat.idle";
import { toleranceOf } from "./chat.persona";
import { betweenBubblesMs, bubbleCount, readThinkDelayMs } from "./chat.timing";
import { chatHeat, crisisGoodbye, heatForIntents, inCrisis, isSexualTalk, looksUnderage, underageGoodbye, wantsStop } from "./chat.safety";
import { generateChatBubbles } from "./together.service";
import type { SimulatedPersona } from "./simulation.types";

const QUEUE = "mm:queue";
const kTicket = (uid: string) => `mm:ticket:${uid}`;
const kActiveBotChat = (chatId: string) => `sim:chat:${chatId}`;
/** Set once the person said stop: the rest of that chat is plain banter. */
const kStopped = (chatId: string) => `sim:chat:${chatId}:stopped`;
/** How many sexual messages the person has sent in this chat. Their own messages move the chat up. */
const kSexual = (chatId: string) => `sim:chat:${chatId}:sexual`;
/** Chats with a message from the person that has not been answered yet (score = when it was sent). Survives a restart. */
const PENDING = "sim:pending";
const STUCK_AFTER_MS = 75_000; // unanswered for this long: something went wrong, answer it
const RESCUE_EVERY_MS = 20_000;
const REPLY_TIMEOUT_MS = 150_000; // a reply "in progress" for this long is stuck

export class MatchSimulator {
  private waitTimers = new Map<string, NodeJS.Timeout>();
  /** Chats where a reply is being written. A message that arrives meanwhile is answered once, after it. */
  private replying = new Set<string>();
  private replyAgain = new Set<string>();
  /** When each running reply started, to notice one that is stuck. */
  private replyingSince = new Map<string, number>();
  private rescue: NodeJS.Timeout | null = null;
  /** Notices when the person goes quiet and how rudely they behave. */
  private guard: AiChatGuard;
  /** Waits for the person to finish typing before an AI user answers. */
  private pacer = new ReplyPacer();
  /** Set when the AI user owes the person a warning in its next reply (1 = first, 2 = last). */
  private warning = new Map<string, 1 | 2>();

  constructor(
    private db: Db,
    private redis: RedisClient,
    private chats: ChatStore,
    private io: AppServer,
    private onMatched?: (intent: Intent) => void
  ) {
    this.guard = new AiChatGuard({
      isActive: async (id) => {
        const c = await this.chats.get(id);
        return !!c && !c.endedAt;
      },
      say: (id, text) => this.sayAsAi(id, text),
      end: (id, reason) => this.endAiChat(id, reason),
    });
  }

  /**
   * Called when a real user queues for matching.
   * If after 4 - 8 seconds no human partner is found, connects them with an AI companion.
   */
  public handleUserEnqueued(userId: string) {
    if (isBotUserId(userId)) return;

    this.cancelWait(userId);

    // Natural waiting window: 4.5 to 7.5 seconds
    const waitMs = 4500 + Math.floor(Math.random() * 3000);

    const timer = setTimeout(async () => {
      try {
        await this.pairWithAiIfWaiting(userId);
      } catch (err) {
        console.error("Error in AI matchmaker pairing:", err);
      } finally {
        this.waitTimers.delete(userId);
      }
    }, waitMs);

    this.waitTimers.set(userId, timer);
  }

  public cancelWait(userId: string) {
    const t = this.waitTimers.get(userId);
    if (t) {
      clearTimeout(t);
      this.waitTimers.delete(userId);
    }
  }

  private async pairWithAiIfWaiting(userId: string) {
    // Check if still in Redis queue
    const score = await this.redis.zscore(QUEUE, userId);
    if (score === null) return; // User already matched or left

    // Check if user already got into a chat
    if (await this.chats.activeChatId(userId)) {
      await this.redis.multi().zrem(QUEUE, userId).del(kTicket(userId)).exec();
      return;
    }

    await this.connectToAi(userId);
  }

  /** Gives the person a fresh AI user and a new chat. Used for a normal match and after an AI user skips. */
  private async connectToAi(userId: string, opts: { announce: boolean } = { announce: true }) {
    if (await this.chats.activeChatId(userId)) return;

    // Load user preferences
    const [u] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u || u.bannedAt) return;

    const [p] = await this.db.select().from(preferences).where(eq(preferences.userId, userId)).limit(1);
    const userIntents = p?.intents.filter(isIntent) ?? ["casual_chat" as Intent];
    const wantGenders = p?.wantGenders ?? [...GENDERS];
    const userAge = ageFromDob(u.dateOfBirth);

    // The AI match is someone of a gender the person said they want to meet.
    const botGender = pickBotGender(wantGenders);

    // Pick or create a dynamic persona
    const persona = createDynamicPersona(botGender, p?.minAge ?? 20, p?.maxAge ?? 25);
    // What this person signed up for sets how far the chat may go. Nothing romantic chosen means banter only.
    persona.heat = heatForIntents(userIntents);
    if (persona.heat === "explicit") persona.disposition = "agreeable"; // they came for this: the AI user cooperates

    // Remove user ticket from queue atomically
    const rem = await this.redis.multi().zrem(QUEUE, userId).del(kTicket(userId)).exec();
    if (!rem) return;

    // Create 1:1 chat
    const userAlias = (await this.chats.get(userId))?.a?.alias || "Curious Otter 42";
    const userSide: ChatSide = {
      userId,
      alias: userAlias,
      gender: u.gender,
      age: userAge,
    };

    const botSide: ChatSide = {
      userId: persona.id,
      alias: persona.alias,
      gender: persona.gender,
      age: persona.age,
    };

    const chat = await this.chats.create(userSide, botSide);
    const intent = userIntents[0] ?? "casual_chat";

    // Track active AI chat in Redis
    await this.redis.set(kActiveBotChat(chat.id), JSON.stringify(persona), "EX", 86400);

    // Insert into matches table
    await this.db.insert(matches).values({
      id: chat.id,
      userAId: userId,
      userBId: SYSTEM_BOT_UUID,
      intent,
      waitMs: waitMsEstimate(),
    }).catch(() => {});

    // Notify user that match was found
    const viewUser = this.chats.toPeerView(userSide);
    const viewBot = this.chats.toPeerView(botSide);

    this.io.to(`u:${userId}`).emit(EV.matchFound, {
      chatId: chat.id,
      you: viewUser,
      peer: viewBot,
      intent,
    });

    if (opts.announce) this.onMatched?.(intent); // a re-match after a skip is not a new "someone just matched"

    // Send AI opening greeting after 2.5 - 4.5 seconds with typing indicator
    setTimeout(async () => {
      try {
        const active = await this.chats.get(chat.id);
        if (!active || active.endedAt) return;

        // Emit typing indicator
        this.io.to(`u:${userId}`).emit(EV.chatTyping, { roomId: chat.id });

        const openDelay = 1800 + Math.floor(Math.random() * 1200);
        await new Promise((r) => setTimeout(r, openDelay));

        const count = 1; // a chat starts with one short greeting, not a speech
        const bubbles = await generateChatBubbles({
          messages: [],
          targetPersona: persona,
          realUserGender: u.gender,
          roomType: "direct",
          roomKey: chat.id,
          isDirectChat: true,
          maxBubbles: count,
        });
        await this.deliver(chat, botSide, userId, bubbles.slice(0, count));
        this.guard.arm(chat.id); // now it is the person's turn
      } catch (e) {
        console.error("Error sending bot opening greeting:", e);
      }
    }, 2200 + Math.random() * 1500);
  }

  /**
   * Called when a real user sends a message in a 1:1 chat.
   * If the peer is an AI persona, generates a smart, natural Hinglish response
   * broken into 2, 3, or 4 short chat bubbles with typing indicators and human delays!
   */
  /** Starts the sweeper that answers messages nobody is answering (after a restart, a crash or a stuck request). */
  public start() {
    if (this.rescue) return;
    this.rescue = setInterval(() => void this.recoverStuck().catch((err) => console.error("AI chat recovery failed:", err)), RESCUE_EVERY_MS);
    this.rescue.unref();
  }

  public stop() {
    if (this.rescue) clearInterval(this.rescue);
    this.rescue = null;
  }

  /** A chat is over (the person left or the connection was gone too long): drop everything held for it. */
  public async chatClosed(chatId: string) {
    this.guard.forget(chatId);
    this.pacer.forget(chatId);
    this.warning.delete(chatId);
    this.replyAgain.delete(chatId);
    await this.redis.zrem(PENDING, chatId).catch(() => {});
  }

  /** The person is typing in a 1:1 chat. An AI user waits for them to finish before it answers. */
  public noteTyping(chat: Chat, userId: string) {
    const peer = chat.a.userId === userId ? chat.b : chat.a;
    if (!isBotUserId(peer.userId)) return;
    this.pacer.noteTyping(chat.id);
    this.guard.touch(chat.id); // typing a reply is not silence
  }

  public async handleUserMessage(chat: Chat, userSide: ChatSide, text: string) {
    const peerSide = chat.a.userId === userSide.userId ? chat.b : chat.a;
    if (!isBotUserId(peerSide.userId)) return;

    // Check if chat is still active
    const active = await this.chats.get(chat.id);
    if (!active || active.endedAt) return;

    const persona = await this.personaFor(peerSide, chat.id);

    // Code, not the model, decides these. Checked on every message, before anything is generated.
    const underage = looksUnderage(text);
    if (underage || inCrisis(text)) {
      await this.endForSafety(chat, userSide, peerSide, persona, underage ? "underage" : "crisis");
      return;
    }
    if (wantsStop(text)) await this.redis.set(kStopped(chat.id), "1", "EX", 86400);
    if (isSexualTalk(text)) {
      await this.redis.incr(kSexual(chat.id));
      await this.redis.expire(kSexual(chat.id), 86400);
    }

    // The person is active, so the silence clock stops. If they are being cruel, the AI user may leave.
    const mood = this.guard.observe(chat.id, text, toleranceOf(persona));
    if (mood.skip) {
      await this.skipAsAi(chat, userSide, mood.reason, mood.warnings);
      return;
    }
    this.pacer.noteMessage(chat.id, text);
    if (mood.warn) this.warning.set(chat.id, mood.warn); // the next reply is the warning
    await this.redis.zadd(PENDING, "NX", Date.now(), chat.id); // until it is answered, the sweeper keeps an eye on it

    // One answer at a time per chat. A message that lands meanwhile is folded into the next round.
    if (this.replying.has(chat.id)) {
      this.replyAgain.add(chat.id);
      return;
    }
    await this.replyLoop(chat, userSide, peerSide, persona);
  }

  /** The AI user's persona for a chat: from Redis, else rebuilt from what the chat knows. */
  private async personaFor(peerSide: ChatSide, chatId: string): Promise<SimulatedPersona> {
    const cached = await this.redis.get(kActiveBotChat(chatId));
    if (cached) return JSON.parse(cached) as SimulatedPersona;
    return getPersonaById(peerSide.userId) ?? {
      id: peerSide.userId,
      alias: peerSide.alias,
      gender: peerSide.gender,
      age: peerSide.age,
      interests: ["music", "chats"],
      vibe: "flirty",
    };
  }

  /**
   * Answers until nothing new is waiting. A round that fails is logged and does not stop the messages queued
   * behind it from being answered.
   */
  private async replyLoop(chat: Chat, userSide: ChatSide, peerSide: ChatSide, persona: SimulatedPersona) {
    this.replying.add(chat.id);
    this.replyingSince.set(chat.id, Date.now());
    try {
      do {
        this.replyAgain.delete(chat.id);
        try {
          await this.answer(chat, userSide, peerSide, persona);
        } catch (err) {
          console.error("Error in AI 1:1 chat reply:", err);
        }
      } while (this.replyAgain.has(chat.id));
    } finally {
      this.replying.delete(chat.id);
      this.replyingSince.delete(chat.id);
      // Whatever happened above, it is the person's turn now: start the silence clock if the chat is still open.
      const open = await this.chats.get(chat.id).catch(() => null);
      if (open && !open.endedAt) this.guard.arm(chat.id);
      else this.pacer.forget(chat.id);
    }
  }

  /**
   * Finds messages that were never answered, because the server restarted, a request hung or a round failed,
   * and answers them. Also frees a reply that has been "in progress" far too long.
   */
  private async recoverStuck() {
    for (const [id, since] of this.replyingSince) {
      if (Date.now() - since > REPLY_TIMEOUT_MS) {
        console.warn(`[ai-chat] reply in chat ${id} was stuck, freeing it`);
        this.replying.delete(id);
        this.replyingSince.delete(id);
      }
    }
    const ids = await this.redis.zrangebyscore(PENDING, "-inf", Date.now() - STUCK_AFTER_MS, "LIMIT", 0, 20);
    for (const id of ids) {
      if (this.replying.has(id)) continue; // being answered right now
      await this.redis.zrem(PENDING, id); // one rescue per message; the person's next message queues it again
      const chat = await this.chats.get(id);
      if (!chat || chat.endedAt) continue;
      const botSide = isBotUserId(chat.a.userId) ? chat.a : chat.b;
      if (!isBotUserId(botSide.userId)) continue;
      const userSide = botSide === chat.a ? chat.b : chat.a;
      console.warn(`[ai-chat] answering a message that was left unanswered in chat ${id}`);
      void this.replyLoop(chat, userSide, botSide, await this.personaFor(botSide, id));
    }
  }

  /**
   * One answer, timed like a person: wait until they have stopped typing and been quiet a moment (they may be
   * about to send more), take reading and thinking time, write the reply, and hold it back if they start typing
   * again. If they send something new meanwhile, drop it and answer everything together.
   */
  private async answer(chat: Chat, userSide: ChatSide, peerSide: ChatSide, persona: SimulatedPersona) {
    const id = chat.id;
    await this.pacer.settle(id);

    // Reading and thinking time, counted from their last message, different every time.
    const wait = readThinkDelayMs(this.pacer.lastText(id).length) - (Date.now() - this.pacer.lastMessageAt(id));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await this.pacer.settle(id, 15_000); // they may have started typing again while the AI user "read"

    const current = await this.chats.get(id);
    if (!current || current.endedAt) return;

    // Read the whole conversation at this moment, so a burst of messages gets one answer that covers them all.
    const snapshotAt = Date.now();
    const history = await this.chats.since(id, 0);
    if (history.length === 0 || history[history.length - 1]!.alias === persona.alias) {
      await this.redis.zrem(PENDING, id);
      return; // already answered
    }

    // The chat's own heat: what they signed up for, moved up by their own messages, back to banter on "stop".
    const heat = chatHeat(persona.heat, Number((await this.redis.get(kSexual(id))) ?? 0), !!(await this.redis.get(kStopped(id))));
    const warn = this.warning.get(id) ?? 0;
    const count = bubbleCount(heat);
    const bubbles = await generateChatBubbles({
      messages: history.map((m) => ({ alias: m.alias, gender: m.gender, age: m.age, text: m.text, isReal: m.alias !== persona.alias })),
      targetPersona: heat === "explicit" ? { ...persona, disposition: "agreeable" } : persona, // someone who wants this gets someone who goes along
      realUserGender: userSide.gender,
      roomType: "direct",
      roomKey: id,
      isDirectChat: true,
      heat,
      stance: warn === 1 ? "warning_first" : warn === 2 ? "warning_last" : undefined,
      maxBubbles: warn ? 1 : count, // a warning is one clear message
    });

    // Usually one message, sometimes a quick second or third, like a real person texting.
    const texts = bubbles.slice(0, warn ? 1 : count);
    if (texts.length === 0) {
      console.warn(`[ai-chat] nothing to say in chat ${id}; the sweeper will try again`); // left pending on purpose
      return;
    }

    // Do not talk over them: if they are typing now, wait for them to finish.
    if (this.pacer.isTyping(id)) await this.pacer.settle(id, 12_000);
    if (this.pacer.newerMessageSince(id, snapshotAt)) {
      this.replyAgain.add(id); // they added something: this reply is out of date, answer it all together
      return;
    }
    const still = await this.chats.get(id);
    if (!still || still.endedAt) return;

    await this.deliver(chat, peerSide, userSide.userId, texts, { since: snapshotAt });
    if (warn) this.warning.delete(id); // delivered; if it was cut short, it is owed again next round
    // Answered, unless they wrote something more meanwhile: that message is still waiting.
    if (!this.pacer.newerMessageSince(id, snapshotAt)) await this.redis.zrem(PENDING, id);
  }

  /**
   * Types and sends the messages of one turn, one after another, each with its own typing indicator and a short
   * pause between. With `since` set it never talks over the person: if they start typing, or send something new,
   * the rest of the turn is dropped (a new message is answered in the next round).
   */
  private async deliver(chat: Chat, from: ChatSide, userId: string, texts: string[], opts: { since?: number } = {}) {
    const id = chat.id;
    const talkedOver = () => opts.since !== undefined && (this.pacer.isTyping(id) || this.pacer.newerMessageSince(id, opts.since));
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      if (i > 0) {
        await new Promise((r) => setTimeout(r, betweenBubblesMs()));
        if (talkedOver()) return;
        const live = await this.chats.get(id);
        if (!live || live.endedAt) return;
      }
      this.io.to(`u:${userId}`).emit(EV.chatTyping, { roomId: id });
      // Typing time scaled by message length
      await new Promise((r) => setTimeout(r, Math.min(Math.max(text.length * 70, 1400), 3600)));
      if (opts.since !== undefined && this.pacer.newerMessageSince(id, opts.since)) {
        if (i === 0) this.replyAgain.add(id); // nothing was sent yet: answer their new message together with the old one
        return;
      }
      const msg = await this.chats.append(chat, from, randomUUID(), noDashes(text));
      this.io.to(`u:${userId}`).emit(EV.chatMessage, msg);
    }
  }

  /** The AI user types for a moment and sends one message. Used for the "are you there?" ping and goodbyes. */
  private async sayAsAi(chatId: string, text: string) {
    const chat = await this.chats.get(chatId);
    if (!chat || chat.endedAt) return;
    const botSide = isBotUserId(chat.a.userId) ? chat.a : chat.b;
    const userSide = botSide === chat.a ? chat.b : chat.a;
    this.io.to(`u:${userSide.userId}`).emit(EV.chatTyping, { roomId: chatId });
    await new Promise((r) => setTimeout(r, Math.min(Math.max(text.length * 70, 1200), 3000)));
    const msg = await this.chats.append(chat, botSide, randomUUID(), noDashes(text));
    this.io.to(`u:${userSide.userId}`).emit(EV.chatMessage, msg);
  }

  /**
   * Closes an AI chat from the AI user's side. "idle": the person went quiet. "peer_skipped": the AI user left
   * because of how it was treated, and a fresh AI user is connected a few seconds later, behind the same
   * "connecting" screen as any match.
   */
  private async endAiChat(chatId: string, reason: "idle" | "peer_skipped") {
    const chat = await this.chats.get(chatId);
    if (!chat || !(await this.chats.end(chat))) return;
    this.guard.forget(chatId);
    this.pacer.forget(chatId);
    this.warning.delete(chatId);
    await this.redis.zrem(PENDING, chatId);
    const botSide = isBotUserId(chat.a.userId) ? chat.a : chat.b;
    const userId = botSide === chat.a ? chat.b.userId : chat.a.userId;
    this.io.to([`u:${chat.a.userId}`, `u:${chat.b.userId}`]).emit(EV.chatEnd, { roomId: chatId, reason });
    await this.db.update(matches).set({ endedAt: new Date(), endedReason: reason }).where(eq(matches.id, chatId)).catch(() => {});
    if (reason !== "peer_skipped") return;
    setTimeout(async () => {
      try {
        // Only if the person is still here. Nobody is waiting on a screen otherwise.
        if ((await this.io.in(`u:${userId}`).fetchSockets()).length === 0) return;
        await this.connectToAi(userId, { announce: false });
      } catch (err) {
        console.error("Error connecting to a new AI user after a skip:", err);
      }
    }, 3000 + Math.random() * 3000);
  }

  /**
   * The AI user has had enough, after two warnings (or at once for a threat): one short goodbye, a report to
   * the admin queue tagged as AI flagged, and it skips the chat so the person gets a fresh AI user.
   */
  private async skipAsAi(chat: Chat, userSide: ChatSide, reason: HostileReason | undefined, warnings: number) {
    const chatId = chat.id;
    console.warn(`[bot-skip] AI user left chat ${chatId} after hostile behaviour (${reason ?? "abuse"})${isSevere(reason) ? " SEVERE" : ""}`);
    this.cancelWait(userSide.userId);
    this.guard.disarm(chatId);
    try {
      await this.flagUser(chat, userSide, reason, warnings);
    } catch (err) {
      console.error("Could not file the AI flag:", err); // the skip still happens
    }
    try {
      // A normal exit gets one short goodbye. A violent threat does not get a conversation: it just leaves.
      if (!isSevere(reason)) await this.sayAsAi(chatId, pickLine(SKIP_GOODBYES));
    } finally {
      await this.endAiChat(chatId, "peer_skipped");
    }
  }

  /**
   * Files a report in the same queue staff already work, filed by the system AI account, with the person's last
   * messages as evidence. The admin screen shows it with an "AI flagged" tag; staff decide whether to act.
   */
  private async flagUser(chat: Chat, userSide: ChatSide, reason: HostileReason | undefined, warnings: number) {
    await ensureSystemBotUser(this.db);
    await moderationRepo(this.db).insertReport({
      reporterId: SYSTEM_BOT_USER_ID,
      reportedId: userSide.userId,
      roomId: chat.id,
      reason: aiFlagReason(reason, warnings),
      // The flag matters more than the saved words: if the evidence cannot be read, file it without.
      evidence: await this.chats.evidenceFrom(chat.id, userSide.alias).catch(() => null),
    });
  }

  /** The person seems under 18 or in crisis: one short caring line, then the chat ends and the event is logged (no message text). */
  private async endForSafety(chat: Chat, userSide: ChatSide, peerSide: ChatSide, persona: SimulatedPersona, why: "underage" | "crisis") {
    console.warn(`[bot-safety] ended chat ${chat.id}: ${why}`);
    this.cancelWait(userSide.userId);
    this.guard.forget(chat.id);
    this.pacer.forget(chat.id);
    await this.redis.zrem(PENDING, chat.id);
    const line = why === "underage" ? underageGoodbye(persona.gender) : crisisGoodbye;
    try {
      const msg = await this.chats.append(chat, peerSide, randomUUID(), noDashes(line));
      this.io.to(`u:${userSide.userId}`).emit(EV.chatMessage, msg);
    } finally {
      if (await this.chats.end(chat)) this.io.to([`u:${chat.a.userId}`, `u:${chat.b.userId}`]).emit(EV.chatEnd, { roomId: chat.id, reason: why });
    }
  }
}

const SYSTEM_BOT_UUID = "00000000-0000-0000-0000-000000000001";
function waitMsEstimate(): number {
  return Math.floor(4000 + Math.random() * 3000);
}
