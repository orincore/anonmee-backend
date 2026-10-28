import { z } from "zod";
import { chatMessageSchema, EV, reactSchema, resumeSchema, roomRefSchema } from "../../contracts";
import { previewOf } from "../../lib/reply";
import { ReactionError, type ReactionsService } from "../../modules/chat/reactions.service";
import { cleanMessage } from "../../lib/text";
import type { ActivityService } from "../../modules/presence/activity.service";
import type { ChatStore } from "../../modules/chat/chat.store";
import type { AppServer, AppSocket } from "../context";
import { HandlerError, handle } from "../handle";
import type { matchingService } from "../../modules/matching/matching.service";
import type { MatchSimulator } from "../../modules/simulation";

/**
 * 1:1 chats are delivered to each person's own `u:<id>` group, which their socket joins itself
 * at connect. A shared room would need a cross-server join that completes after the first
 * messages are already sent, so it is deliberately not used.
 */
export const bothSides = (c: { a: { userId: string }; b: { userId: string } }) => [`u:${c.a.userId}`, `u:${c.b.userId}`];

export async function endChat(io: AppServer, chats: ChatStore, chatId: string, reason: string) {
  const chat = await chats.get(chatId);
  if (!chat || !(await chats.end(chat))) return;
  io.to(bothSides(chat)).emit(EV.chatEnd, { roomId: chatId, reason });
}

export function registerChatHandlers(
  socket: AppSocket,
  io: AppServer,
  chats: ChatStore,
  reactions: ReactionsService,
  matching: ReturnType<typeof matchingService>,
  onEnded: (chatId: string, reason: string) => void,
  activity?: ActivityService,
  matchSim?: MatchSimulator,
) {
  const uid = socket.data.userId;

  async function member(roomId: string) {
    const chat = await chats.get(roomId);
    const me = chat && chats.sideOf(chat, uid);
    if (!chat || !me) throw new HandlerError("not_in_chat", "That chat is not available.");
    return { chat, me };
  }

  handle(socket, EV.chatMessage, chatMessageSchema, async (d, ack) => {
    const { chat, me } = await member(d.roomId);
    if (chat.endedAt) throw new HandlerError("chat_ended", "This chat has ended.");
    const text = cleanMessage(d.text);
    if (!text) throw new HandlerError("empty", "Write something first.");
    if (!(await chats.firstDelivery(chat.id, d.clientMsgId))) return ack({ ok: true, duplicate: true });
    let replyTo;
    if (d.replyToId) {
      const quoted = await chats.findMessage(chat.id, d.replyToId);
      if (!quoted) throw new HandlerError("bad_reply", "That message is no longer here.");
      replyTo = previewOf(quoted);
    }
    const msg = await chats.append(chat, me, d.clientMsgId, text, replyTo);
    io.to(bothSides(chat)).emit(EV.chatMessage, msg);
    if (activity) void activity.recordMessageSent(uid);
    ack({ ok: true, seq: msg.seq, id: msg.id });

    // AI companion reply in 1:1 chat if peer is bot
    if (matchSim) {
      matchSim.handleUserMessage(chat, me, text).catch((err) => console.error("AI 1:1 reply failed:", err));
    }
  });

  // Throttle typing to once per 2s per chat, per CLAUDE 5.6. Real-time, accurate, with Redis-less per-socket bucket.
  const typingAt = new Map<string, number>();
  handle(socket, EV.chatTyping, roomRefSchema, async (d) => {
    const { chat } = await member(d.roomId);
    if (chat.endedAt) return;
    matchSim?.noteTyping(chat, uid); // an AI user waits for them to finish
    const key = `${uid}:${chat.id}`;
    const now = Date.now();
    const last = typingAt.get(key) ?? 0;
    if (now - last < 1900) return;
    typingAt.set(key, now);
    io.to(`u:${chats.peerOf(chat, uid).userId}`).emit(EV.chatTyping, { roomId: chat.id });
  });

  // "Which chat am I in?" The client asks on load and on every reconnect. The server also pushes chat:active at
  // connect, but a push can arrive before the page is listening; this cannot be missed.
  handle(socket, EV.chatCurrent, z.object({}).passthrough(), async (_d, ack) => {
    const id = await chats.activeChatId(uid);
    const chat = id ? await chats.get(id) : null;
    const me = chat && !chat.endedAt ? chats.sideOf(chat, uid) : null;
    if (chat && me) return ack({ ok: true, chat: { chatId: chat.id, you: chats.toPeerView(me), peer: chats.toPeerView(chats.peerOf(chat, uid)) }, waiting: false });
    ack({ ok: true, chat: null, waiting: await matching.isWaiting(uid) });
  });

  // Reconnect: join the room again and receive everything after the last message the client saw.
  handle(socket, EV.chatResume, resumeSchema, async (d, ack) => {
    const { chat, me } = await member(d.roomId);
    ack({
      ok: true, ended: !!chat.endedAt, you: chats.toPeerView(me), peer: chats.toPeerView(chats.peerOf(chat, uid)),
      messages: await reactions.attach(chat.id, await chats.since(chat.id, d.lastSeq), uid),
    });
  });

  handle(socket, EV.chatReact, reactSchema, async (d, ack) => {
    const { chat } = await member(d.roomId);
    if (chat.endedAt) throw new HandlerError("chat_ended", "This chat has ended.");
    if (!(await chats.findMessage(chat.id, d.messageId))) throw new HandlerError("bad_message", "That message is no longer here.");
    try {
      const r = await reactions.toggle(chat.id, d.messageId, uid, d.emoji);
      io.to(bothSides(chat)).emit(EV.chatReactions, { roomId: chat.id, messageId: d.messageId, reactions: r.reactions });
      ack({ ok: true, mine: r.mine });
    } catch (e) {
      if (e instanceof ReactionError) throw new HandlerError(e.code, e.message);
      throw e;
    }
  });

  handle(socket, EV.chatEnd, roomRefSchema.passthrough(), async (d, ack) => {
    const { chat } = await member(d.roomId);
    await endChat(io, chats, chat.id, "left");
    onEnded(chat.id, "left");
    ack({ ok: true });
  });

  handle(socket, EV.chatSkip, roomRefSchema.passthrough(), async (d, ack) => {
    const { chat } = await member(d.roomId);
    if (chat.endedAt) throw new HandlerError("chat_ended", "This chat has ended.");
    const userA = chat.a.userId;
    const userB = chat.b.userId;

    await endChat(io, chats, chat.id, "skipped");
    onEnded(chat.id, "skipped");

    io.to(bothSides(chat)).emit("match:waiting", {});

    await Promise.allSettled([
      matching.join(userA),
      matching.join(userB),
    ]);

    ack({ ok: true });
  });
}
