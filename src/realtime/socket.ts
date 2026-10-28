import type { Server as HttpServer } from "node:http";
import { parse } from "cookie";
import { eq } from "drizzle-orm";
import { createAdapter } from "@socket.io/redis-adapter";
import { Server } from "socket.io";
import { env } from "../config/env";
import { ageFromDob, EV, screenHeartbeatSchema } from "../contracts";
import type { Db } from "../db/client";
import { matches, users } from "../db/schema";
import { verifyAccess } from "../lib/tokens";
import type { RedisClient } from "../lib/redis";
import { chatStore } from "../modules/chat/chat.store";
import { matchingService, type MatchNotifier } from "../modules/matching/matching.service";
import { groupOfIntent } from "../contracts";
import { moderationRepo } from "../modules/moderation/moderation.repo";
import type { ActivityService } from "../modules/presence/activity.service";
import { presenceService } from "../modules/presence/presence.service";
import { pulseService } from "../modules/presence/pulse.service";
import type { AppSocket } from "./context";
import { endChat, registerChatHandlers } from "./handlers/chat.handlers";
import { registerRoomHandlers } from "./handlers/room.handlers";
import { reactionsService } from "../modules/chat/reactions.service";
import { roomsService } from "../modules/chat/rooms.service";
import { typingStore } from "../modules/chat/typing.store";
import { groupsRepo } from "../modules/groups/groups.repo";
import { registerMatchHandlers } from "./handlers/match.handlers";
import { BotGate, botUsage, GlobalChatSimulator, GroupSimulator, isBotUserId, MatchSimulator } from "../modules/simulation";
import type { Intent } from "../contracts";

/** How long a dropped connection may take to come back before the chat is given up: a refresh, a tunnel, a phone changing network. */
const CHAT_GRACE_MS = process.env.NODE_ENV === "test" ? 1500 : 30_000;
/** The same, when the page said it was closing (pagehide): a refresh still makes it back, a closed tab does not wait half a minute. */
const LEAVE_GRACE_MS = process.env.NODE_ENV === "test" ? 700 : 15_000;
const QUEUE_GRACE_MS = 5_000;

export function createRealtime(httpServer: HttpServer, db: Db, redis: RedisClient, chats = chatStore(redis), activity?: ActivityService) {
  const io = new Server(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    maxHttpBufferSize: 16 * 1024,
    serveClient: false,
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });

  // Rooms have no size limit, so broadcasts must work across several server processes.
  const pub = redis.duplicate({ enableOfflineQueue: true });
  const sub = redis.duplicate({ enableOfflineQueue: true });
  io.adapter(createAdapter(pub, sub));
  const presence = presenceService(redis);
  const reactions = reactionsService(redis);
  const typing = typingStore(redis);
  const rooms = roomsService(db, redis, reactions);
  const notifier: MatchNotifier = {
    found(userId, p) {
      io.to(`u:${userId}`).emit(EV.matchFound, p);
    },
    timeout: (userId) => void io.to(`u:${userId}`).emit(EV.matchTimeout, {}),
  };
  const pulse = pulseService(redis);
  const onMatchedCb = (intent: Intent) => {
    const e = { kind: "match" as const, intent: groupOfIntent(intent), at: Date.now() };
    void pulse.record(e);
    io.of("/public").emit(EV.pulse, e);
  };
  const matching = matchingService({
    db, redis, chats, moderation: moderationRepo(db), notify: notifier,
    onMatched: onMatchedCb,
  });

  // AI companions only run while a real person is connected, and their spend is metered against a daily budget.
  botUsage.attach(redis);
  const botGate = new BotGate(io, presence);
  const globalSim = new GlobalChatSimulator(io, redis, rooms, botGate, typing);
  const groupSim = new GroupSimulator(db, redis, rooms, io, botGate);
  const matchSim = new MatchSimulator(db, redis, chats, io, onMatchedCb);

  globalSim.start();
  groupSim.start();
  matchSim.start(); // answers any 1:1 message that was left unanswered (restart, crash, stuck request)

  // Public namespace: anyone (even signed-out visitors) may watch the online counter, nothing else.
  const publicNs = io.of("/public");
  publicNs.on("connection", async (s) => void s.emit(EV.presenceCount, { count: await presence.count() }));

  // Handshake: signed-in cookie, allowed origin, active account.
  io.use(async (socket, next) => {
    try {
      const origin = socket.handshake.headers.origin;
      if (origin && origin !== env.WEB_ORIGIN) return next(new Error("forbidden"));
      const token = parse(socket.handshake.headers.cookie ?? "").access;
      const userId = token ? await verifyAccess(token) : null;
      if (!userId) return next(new Error("unauthorized"));
      const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!u || u.bannedAt) return next(new Error("unauthorized"));
      socket.data = { userId, gender: u.gender, age: ageFromDob(u.dateOfBirth) };
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  const localUsers = new Map<string, number>();
  const localCount = (uid: string) => localUsers.get(uid) ?? 0;

  async function stillGone(uid: string) {
    return (await io.in(`u:${uid}`).fetchSockets()).length === 0;
  }

  /**
   * Someone left a 1:1 chat by closing the page and not coming back. That counts as them skipping it: against an AI
   * user the chat is simply closed; against a person, the chat ends with "peer_left" and that person is put straight
   * back into matching (behind the normal "connecting you to a new user" screen).
   */
  async function leaveChat(chatId: string, leaverId: string) {
    const chat = await chats.get(chatId);
    const peer = chat ? chats.peerOf(chat, leaverId) : null;
    const vsAi = !!peer && isBotUserId(peer.userId);
    await endChat(io, chats, chatId, peer && !vsAi ? "peer_left" : "disconnected");
    await endedRecord(chatId, "disconnected");
    if (vsAi) return void matchSim.chatClosed(chatId);
    if (!peer) return;
    try {
      await matching.join(peer.userId);
      matchSim.handleUserEnqueued(peer.userId); // an AI user steps in if nobody else turns up
    } catch {
      // No preferences set, or already in another chat: let them start matching themselves.
      io.to(`u:${peer.userId}`).emit(EV.matchTimeout, {});
    }
  }

  function endedRecord(chatId: string, reason: string) {
    return db.update(matches).set({ endedAt: new Date(), endedReason: reason }).where(eq(matches.id, chatId));
  }

  io.on("connection", async (raw) => {
    const socket = raw as AppSocket;
    const uid = socket.data.userId;
    // Handlers first, with no await before them: a client may emit the instant it connects.
    let leaving = false;
    socket.on(EV.chatLeaving, () => {
      leaving = true; // the page is closing or reloading; if the connection does not come back soon, the chat is over
    });
    registerMatchHandlers(socket, matching, matchSim);
    registerChatHandlers(socket, io, chats, reactions, matching, (id, why) => {
        void endedRecord(id, why);
        void matchSim.chatClosed(id); // an AI user stops waiting for a person who has left
      }, activity, matchSim);
    registerRoomHandlers(socket, io, rooms, typing, activity, globalSim, groupSim, () => botGate.wake());
    socket.on(EV.screenHeartbeat, (data: unknown) => {
      const p = screenHeartbeatSchema.safeParse(data);
      if (p.success && activity) {
        void activity.recordScreenTime(uid, p.data.seconds);
        void presence.touch(uid);
      }
    });
    localUsers.set(uid, localCount(uid) + 1);
    await socket.join(`u:${uid}`);
    await socket.join("r:global");
    try {
      const joined = await groupsRepo(db).joinedIds(uid);
      for (const gid of joined) {
        await socket.join(`r:${gid}`);
      }
    } catch (e) {
      console.error("failed to join group rooms", e);
    }
    await presence.touch(uid);
    botGate.wake(); // someone is here: wake any sleeping room at once
    // Send the current count immediately so the client never waits for the 3-second broadcast interval.
    void presence.count().then((count) => socket.emit(EV.presenceCount, { count }));

    // Tell a returning user about the chat they are still in or the match they were waiting for.
    const active = await chats.activeChatId(uid);
    if (active) {
      const chat = await chats.get(active);
      const me = chat && chats.sideOf(chat, uid);
      if (chat && me) {
        socket.emit(EV.chatActive, { chatId: active, you: chats.toPeerView(me), peer: chats.toPeerView(chats.peerOf(chat, uid)) });
      }
    } else if (await matching.isWaiting(uid)) {
      socket.emit("match:waiting", {});
    }

    socket.on("disconnect", () => {
      const left = localCount(uid) - 1;
      if (left > 0) localUsers.set(uid, left);
      else localUsers.delete(uid);
      setTimeout(async () => {
        if (!(await stillGone(uid))) return;
        matchSim.cancelWait(uid);
        await matching.leave(uid);
      }, QUEUE_GRACE_MS).unref();
      setTimeout(async () => {
        if (!(await stillGone(uid))) return;
        await presence.remove(uid);
        const id = await chats.activeChatId(uid);
        if (id) await leaveChat(id, uid);
      }, leaving ? LEAVE_GRACE_MS : CHAT_GRACE_MS).unref();
    });
  });

  // Background loops: pairing sweep, presence heartbeat, online counter broadcast.
  let lastCount = -1;
  const timers = [
    setInterval(() => void rooms.flush().catch((e) => console.error("flush", e)), 250),
    setInterval(() => void matching.sweep().catch((e) => console.error("sweep", e)), 1000),
    setInterval(() => void Promise.all([...localUsers.keys()].map((u) => presence.touch(u))), 20_000),
    setInterval(async () => {
      const count = await presence.count();
      if (count === lastCount) return;
      lastCount = count;
      io.emit(EV.presenceCount, { count });
      publicNs.emit(EV.presenceCount, { count });
    }, 3000),
  ];
  for (const t of timers) t.unref();

  return {
    io, matching, chats, presence, rooms, pulse,
    /** Ends a 1:1 chat if the id is one. Safe to call with a group or global id. */
    async endChatNow(chatId: string, reason: string) {
      if (!(await chats.get(chatId))) return;
      await endChat(io, chats, chatId, reason);
      await endedRecord(chatId, reason);
    },
    async close() {
      globalSim.stop();
      groupSim.stop();
      matchSim.stop();
      timers.forEach(clearInterval);
      await rooms.flush().catch(() => {});
      await io.close();
      pub.disconnect();
      sub.disconnect();
    },
  };
}
export type Realtime = ReturnType<typeof createRealtime>;
