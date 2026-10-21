import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { ChatMessage, Gender, ReplyPreview } from "../../contracts";
import type { Db } from "../../db/client";
import { roomMessages } from "../../db/schema";
import { recordActivity } from "../../lib/activity";
import { randomAlias } from "../../lib/alias";
import { previewOf } from "../../lib/reply";
import type { RedisClient } from "../../lib/redis";
import { cleanMessage } from "../../lib/text";
import { groupsRepo } from "../groups/groups.repo";
import type { ReactionsService } from "./reactions.service";

export const GLOBAL_ROOM = "global";
const ALIAS_TTL_S = 24 * 3600;
const MEMBER_TTL_S = 3600;
const RECENT_KEEP = 100; // messages held in Redis per room
const RECENT_TTL_S = 24 * 3600;
const HISTORY = 50;
const CATCH_UP_MAX = 200;
const FLOOD_MAX = 20;
const FLOOD_WINDOW_S = 10;
const PENDING = "rooms:pending";
const FLUSH_BATCH = 500;

export class RoomError extends Error {
  constructor(readonly code: "not_member" | "empty" | "rate_limited" | "bad_room" | "bad_reply" | "bad_message", message: string) {
    super(message);
  }
}
export interface Sender {
  userId: string;
  gender: Gender;
  age: number;
}

type Row = typeof roomMessages.$inferSelect;
const fromRow = (r: Row): ChatMessage => ({
  id: r.id, roomId: r.roomId, clientMsgId: r.clientMsgId, seq: r.seq, alias: r.alias,
  gender: r.gender, age: r.age, text: r.text, at: r.createdAt.getTime(), ...(r.replyTo ? { replyTo: r.replyTo } : {}),
});
/** What goes to Postgres. The user id is stored for moderation but is never part of ChatMessage. */
interface Pending extends ChatMessage {
  userId: string;
}
const mergeBySeq = (...lists: ChatMessage[][]) => {
  const m = new Map<number, ChatMessage>();
  for (const l of lists) for (const x of l) m.set(x.seq, x);
  return [...m.values()].sort((a, b) => a.seq - b.seq);
};

/**
 * Group and global chat, built so Postgres sees almost no read traffic and only batched writes:
 *  - sending: Redis only (sequence number, dedupe, recent window, pending queue). One round trip.
 *  - history on join: served from the Redis recent window.
 *  - older pages and long catch-ups: keyset queries on (room_id, seq), the table's unique index.
 *  - a background flusher writes pending messages in multi-row inserts every few hundred ms.
 */
export function roomsService(db: Db, redis: RedisClient, reactions: ReactionsService) {
  const groups = groupsRepo(db);
  const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
  const kRecent = (r: string) => `room:${r}:recent`;

  async function aliasFor(userId: string, roomId: string): Promise<string | null> {
    if (roomId === GLOBAL_ROOM) {
      const key = `global:alias:${userId}`;
      const mine = randomAlias();
      if ((await redis.set(key, mine, "EX", ALIAS_TTL_S, "NX")) === "OK") {
        await redis.set(`global:alias:rev:${mine}`, userId, "EX", ALIAS_TTL_S);
        return mine;
      }
      return redis.get(key);
    }
    if (!isUuid(roomId)) return null;
    const cacheKey = `member:${roomId}:${userId}`;
    const hit = await redis.get(cacheKey);
    if (hit) return hit;
    const alias = await groups.memberAlias(roomId, userId); // only on a cache miss
    if (alias) await redis.set(cacheKey, alias, "EX", MEMBER_TTL_S);
    return alias;
  }

  async function nextSeq(roomId: string): Promise<number> {
    const key = `room:${roomId}:seq`;
    if (!(await redis.exists(key))) {
      const [{ m }] = (await db.select({ m: sql<number>`coalesce(max(${roomMessages.seq}), 0)::int` }).from(roomMessages).where(eq(roomMessages.roomId, roomId))) as [{ m: number }];
      await redis.set(key, m, "NX");
    }
    return redis.incr(key);
  }

  /** Finds one message in a room: the Redis window first, then Postgres. */
  async function findMessage(roomId: string, id: string): Promise<ChatMessage | null> {
    const hit = (await recent(roomId)).find((m) => m.id === id);
    if (hit) return hit;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await db.select().from(roomMessages).where(and(eq(roomMessages.roomId, roomId), eq(roomMessages.id, id))).limit(1);
    return row ? fromRow(row) : null;
  }

  async function recent(roomId: string): Promise<ChatMessage[]> {
    return (await redis.lrange(kRecent(roomId), 0, -1)).map((x) => JSON.parse(x) as ChatMessage);
  }

  return {
    aliasFor,
    forgetMember: (roomId: string, userId: string) => redis.del(`member:${roomId}:${userId}`),

    async join(userId: string, roomId: string, lastSeq?: number) {
      const alias = await aliasFor(userId, roomId);
      if (!alias) throw new RoomError("not_member", roomId === GLOBAL_ROOM || isUuid(roomId) ? "Join the group first." : "That room does not exist.");
      const tail = await recent(roomId);
      if (lastSeq === undefined) {
        if (tail.length) return { alias, messages: await reactions.attach(roomId, tail.slice(-HISTORY), userId), hasMore: tail.length > HISTORY || tail[0]!.seq > 1 };
        const rows = (await db.select().from(roomMessages).where(eq(roomMessages.roomId, roomId)).orderBy(desc(roomMessages.seq)).limit(HISTORY + 1));
        return { alias, messages: await reactions.attach(roomId, rows.slice(0, HISTORY).reverse().map(fromRow), userId), hasMore: rows.length > HISTORY };
      }
      const gapCoveredByRedis = tail.length > 0 && tail[0]!.seq <= lastSeq + 1;
      const fromDb = gapCoveredByRedis ? [] : (await db.select().from(roomMessages)
        .where(and(eq(roomMessages.roomId, roomId), gt(roomMessages.seq, lastSeq))).orderBy(asc(roomMessages.seq)).limit(CATCH_UP_MAX)).map(fromRow);
      const messages = mergeBySeq(fromDb, tail.filter((m) => m.seq > lastSeq)).slice(0, CATCH_UP_MAX);
      return { alias, messages: await reactions.attach(roomId, messages, userId), hasMore: false };
    },

    /** Scroll-back: the page of messages just older than `beforeSeq`, oldest first. */
    async older(userId: string, roomId: string, beforeSeq: number, limit: number) {
      if (!(await aliasFor(userId, roomId))) throw new RoomError("not_member", "Join the group first.");
      const tail = (await recent(roomId)).filter((m) => m.seq < beforeSeq);
      const needDb = tail.length < limit && (tail.length === 0 || tail[0]!.seq > 1);
      const rows = needDb
        ? (await db.select().from(roomMessages).where(and(eq(roomMessages.roomId, roomId), lt(roomMessages.seq, tail[0]?.seq ?? beforeSeq)))
            .orderBy(desc(roomMessages.seq)).limit(limit + 1))
        : [];
      const merged = mergeBySeq(rows.map(fromRow), tail);
      const page = merged.slice(-limit);
      return { messages: await reactions.attach(roomId, page, userId), hasMore: page.length > 0 && (merged.length > limit || (needDb && rows.length > limit - tail.length) || (page[0]!.seq > 1 && needDb)) };
    },

    async post(sender: Sender, roomId: string, clientMsgId: string, rawText: string, replyToId?: string): Promise<{ message: ChatMessage; duplicate: boolean }> {
      const alias = await aliasFor(sender.userId, roomId);
      if (!alias) throw new RoomError("not_member", "Join the group first.");
      const text = cleanMessage(rawText);
      if (!text) throw new RoomError("empty", "Write something first.");

      const floodKey = `rate:room:${sender.userId}:${roomId}`;
      const n = await redis.incr(floodKey);
      if (n === 1) await redis.expire(floodKey, FLOOD_WINDOW_S);
      if (n > FLOOD_MAX) throw new RoomError("rate_limited", "You are sending messages too fast.");

      let replyTo: ReplyPreview | undefined;
      if (replyToId) {
        const quoted = await findMessage(roomId, replyToId);
        if (!quoted) throw new RoomError("bad_reply", "That message is no longer here.");
        replyTo = previewOf(quoted);
      }

      // Retry-safe: the same client message id is delivered once, and the retry gets the same answer.
      const dupKey = `room:${roomId}:dup:${sender.userId}:${clientMsgId}`;
      if ((await redis.set(dupKey, "0", "EX", 300, "NX")) !== "OK") {
        const seq = Number((await redis.get(dupKey)) ?? 0);
        const known = (await recent(roomId)).find((m) => m.seq === seq);
        return { message: known ?? ({ id: "", roomId, clientMsgId, seq, alias, gender: sender.gender, age: sender.age, text, at: Date.now() }), duplicate: true };
      }

      const seq = await nextSeq(roomId);
      await redis.set(dupKey, seq, "EX", 300);
      const message: Pending = { id: randomUUID(), roomId, clientMsgId, seq, alias, gender: sender.gender, age: sender.age, text, at: Date.now(), userId: sender.userId, ...(replyTo ? { replyTo } : {}) };
      const { userId: _omit, ...publicMsg } = message;
      await redis.multi()
        .rpush(kRecent(roomId), JSON.stringify(publicMsg)).ltrim(kRecent(roomId), -RECENT_KEEP, -1).expire(kRecent(roomId), RECENT_TTL_S)
        .rpush(PENDING, JSON.stringify(message))
        .exec();
      void recordActivity(redis, roomId);
      return { message: publicMsg, duplicate: false };
    },

    /** Toggle one reaction on a message, for people who are in the room. Returns the new counts. */
    async react(userId: string, roomId: string, messageId: string, emoji: string) {
      if (!(await aliasFor(userId, roomId))) throw new RoomError("not_member", "Join the group first.");
      if (!(await findMessage(roomId, messageId))) throw new RoomError("bad_message", "That message is no longer here.");
      return reactions.toggle(roomId, messageId, userId, emoji);
    },

    /** Moves queued messages into Postgres in batches. Safe to run on every server at once. */
    async flush(): Promise<number> {
      const lock = randomUUID();
      if ((await redis.set("rooms:flush:lock", lock, "PX", 5000, "NX")) !== "OK") return 0;
      let total = 0;
      try {
        for (;;) {
          const raw = await redis.lrange(PENDING, 0, FLUSH_BATCH - 1);
          if (raw.length === 0) break;
          const items = raw.map((r) => JSON.parse(r) as Pending);
          const toRow = (m: Pending) => ({
            id: m.id, roomId: m.roomId, seq: m.seq, clientMsgId: m.clientMsgId, userId: m.userId, alias: m.alias,
            gender: m.gender, age: m.age, text: m.text, replyTo: m.replyTo ?? null, createdAt: new Date(m.at),
          });
          try {
            await db.insert(roomMessages).values(items.map(toRow)).onConflictDoNothing();
          } catch {
            // One bad row (for example a deleted user) must not block everyone behind it.
            for (const m of items) {
              try { await db.insert(roomMessages).values(toRow(m)).onConflictDoNothing(); }
              catch (e) { console.error("dropping unsaveable message", m.id, (e as Error).message); }
            }
          }
          await redis.ltrim(PENDING, raw.length, -1);
          total += raw.length;
          if (raw.length < FLUSH_BATCH) break;
        }
      } finally {
        if ((await redis.get("rooms:flush:lock")) === lock) await redis.del("rooms:flush:lock");
      }
      return total;
    },
  };
}
export type RoomsService = ReturnType<typeof roomsService>;
