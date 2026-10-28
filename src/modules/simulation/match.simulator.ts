import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ageFromDob, EV, isIntent, type ChatMessage, type Gender, type Intent, type PeerView } from "../../contracts";
import type { Db } from "../../db/client";
import { matches, preferences, users } from "../../db/schema";
import type { RedisClient } from "../../lib/redis";
import type { Chat, ChatSide, ChatStore } from "../chat/chat.store";
import type { AppServer } from "../../realtime/context";
import { createDynamicPersona, getPersonaById, isBotUserId, selectResponderPersona } from "./persona.service";
import { generateChatBubbles } from "./together.service";
import type { SimulatedPersona } from "./simulation.types";

const QUEUE = "mm:queue";
const kTicket = (uid: string) => `mm:ticket:${uid}`;
const kActiveBotChat = (chatId: string) => `sim:chat:${chatId}`;

export class MatchSimulator {
  private waitTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private db: Db,
    private redis: RedisClient,
    private chats: ChatStore,
    private io: AppServer,
    private onMatched?: (intent: Intent) => void
  ) {}

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

    // Load user preferences
    const [u] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u || u.bannedAt) return;

    const [p] = await this.db.select().from(preferences).where(eq(preferences.userId, userId)).limit(1);
    const userIntents = p?.intents.filter(isIntent) ?? ["casual_chat" as Intent];
    const wantGenders = p?.wantGenders ?? ["anyone"];
    const userAge = ageFromDob(u.dateOfBirth);

    // Determine target persona gender based on preferences
    let botGender: "female" | "male" = "female";
    if (wantGenders.includes("male") && !wantGenders.includes("female")) {
      botGender = "male";
    } else if (wantGenders.includes("female")) {
      botGender = "female";
    } else {
      // If "anyone", 65% female, 35% male
      botGender = Math.random() < 0.65 ? "female" : "male";
    }

    // Pick or create a dynamic persona
    const persona = createDynamicPersona(botGender, p?.minAge ?? 20, p?.maxAge ?? 25);

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

    this.onMatched?.(intent);

    // Send AI opening greeting after 2.5 - 4.5 seconds with typing indicator
    setTimeout(async () => {
      try {
        const active = await this.chats.get(chat.id);
        if (!active || active.endedAt) return;

        // Emit typing indicator
        this.io.to(`u:${userId}`).emit(EV.chatTyping, { roomId: chat.id });

        const openDelay = 1800 + Math.floor(Math.random() * 1200);
        await new Promise((r) => setTimeout(r, openDelay));

        const bubbles = await generateChatBubbles({
          messages: [],
          targetPersona: persona,
          realUserGender: u.gender,
          roomType: "direct",
          isDirectChat: true,
        });

        for (let i = 0; i < Math.min(bubbles.length, 2); i++) {
          const text = bubbles[i]!;
          const msg = await this.chats.append(chat, botSide, randomUUID(), text);
          this.io.to(`u:${userId}`).emit(EV.chatMessage, msg);

          if (i < bubbles.length - 1) {
            this.io.to(`u:${userId}`).emit(EV.chatTyping, { roomId: chat.id });
            await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
          }
        }
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
  public async handleUserMessage(chat: Chat, userSide: ChatSide, text: string) {
    const peerSide = chat.a.userId === userSide.userId ? chat.b : chat.a;
    if (!isBotUserId(peerSide.userId)) return;

    // Check if chat is still active
    const active = await this.chats.get(chat.id);
    if (!active || active.endedAt) return;

    // Retrieve or reconstruct persona
    const cachedPersonaJson = await this.redis.get(kActiveBotChat(chat.id));
    const persona: SimulatedPersona = cachedPersonaJson
      ? JSON.parse(cachedPersonaJson)
      : (getPersonaById(peerSide.userId) || {
          id: peerSide.userId,
          alias: peerSide.alias,
          gender: peerSide.gender as "female" | "male",
          age: peerSide.age,
          interests: ["music", "chats"],
          vibe: "flirty",
        });

    // Start typing indicator after brief reaction delay (800ms - 1.8s)
    setTimeout(async () => {
      const currentChat = await this.chats.get(chat.id);
      if (!currentChat || currentChat.endedAt) return;

      // Show typing indicator to user
      this.io.to(`u:${userSide.userId}`).emit(EV.chatTyping, { roomId: chat.id });

      try {
        // Load recent messages
        const history = await this.chats.since(chat.id, 0);

        const bubbles = await generateChatBubbles({
          messages: history.map((m) => ({
            alias: m.alias,
            gender: m.gender,
            age: m.age,
            text: m.text,
            isReal: m.alias === userSide.alias,
          })),
          targetPersona: persona,
          realUserGender: userSide.gender,
          roomType: "direct",
          isDirectChat: true,
        });

        // Ensure we send 1, 2, 3, or 4 bubbles as requested
        const countToSend = Math.min(Math.max(bubbles.length, 1), 4);

        for (let i = 0; i < countToSend; i++) {
          const bubbleText = bubbles[i] || "haha sach me?";
          const stillActive = await this.chats.get(chat.id);
          if (!stillActive || stillActive.endedAt) return;

          // Typing delay scaled by bubble length (e.g. 1.2s to 3s)
          const typingTime = Math.min(Math.max(bubbleText.length * 70, 1400), 3200);
          this.io.to(`u:${userSide.userId}`).emit(EV.chatTyping, { roomId: chat.id });
          await new Promise((r) => setTimeout(r, typingTime));

          // Send message bubble
          const msg = await this.chats.append(chat, peerSide, randomUUID(), bubbleText);
          this.io.to(`u:${userSide.userId}`).emit(EV.chatMessage, msg);

          // Natural pause before next bubble if multiple
          if (i < countToSend - 1) {
            await new Promise((r) => setTimeout(r, 900 + Math.random() * 800));
          }
        }
      } catch (err) {
        console.error("Error in AI 1:1 chat reply:", err);
      }
    }, 900 + Math.random() * 1200);
  }
}

const SYSTEM_BOT_UUID = "00000000-0000-0000-0000-000000000001";
function waitMsEstimate(): number {
  return Math.floor(4000 + Math.random() * 3000);
}
