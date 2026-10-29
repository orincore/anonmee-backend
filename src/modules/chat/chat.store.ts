import { randomUUID } from "node:crypto";
import { type ChatMessage, type Gender, type PeerView, type ReplyPreview } from "../../contracts";
import type { RedisClient } from "../../lib/redis";

/** After a chat ends we keep it this long so a late report can still find the other person. */
const ENDED_KEEP_S = 10 * 60;
const LIVE_MAX_S = 24 * 3600;
const LOG_MAX = 200;

export interface ChatSide {
  userId: string;
  alias: string;
  gender: Gender;
  age: number;
}
export interface Chat {
  id: string;
  a: ChatSide;
  b: ChatSide;
  endedAt: number | null;
}

const kChat = (id: string) => `chat:${id}`;
const kUser = (uid: string) => `chat:user:${uid}`;
const kLog = (id: string) => `chat:${id}:log`;

/** Called for every message after it is appended. Used to keep a review copy of chats with an AI user (see chat.review.ts). */
export type ChatMessageHook = (chat: Chat, from: ChatSide, msg: ChatMessage) => void;

export function chatStore(redis: RedisClient, onMessage?: ChatMessageHook) {
  async function get(id: string): Promise<Chat | null> {
    const h = await redis.hgetall(kChat(id));
    if (!h.a || !h.b) return null;
    return { id, a: JSON.parse(h.a), b: JSON.parse(h.b), endedAt: h.endedAt ? Number(h.endedAt) : null };
  }
  const sideOf = (c: Chat, uid: string) => (c.a.userId === uid ? c.a : c.b.userId === uid ? c.b : null);

  return {
    get,
    sideOf,
    peerOf: (c: Chat, uid: string) => (c.a.userId === uid ? c.b : c.a),
    toPeerView: (s: ChatSide): PeerView => ({ alias: s.alias, gender: s.gender, age: s.age }),

    async activeChatId(uid: string): Promise<string | null> {
      return redis.get(kUser(uid));
    },

    async create(a: ChatSide, b: ChatSide): Promise<Chat> {
      const id = randomUUID();
      await redis
        .multi()
        .hset(kChat(id), { a: JSON.stringify(a), b: JSON.stringify(b), seq: 0, createdAt: Date.now() })
        .expire(kChat(id), LIVE_MAX_S)
        .set(kUser(a.userId), id, "EX", LIVE_MAX_S)
        .set(kUser(b.userId), id, "EX", LIVE_MAX_S)
        .exec();
      return { id, a, b, endedAt: null };
    },

    /** Idempotent. Returns false if the chat was already over. */
    async end(c: Chat): Promise<boolean> {
      const first = await redis.hsetnx(kChat(c.id), "endedAt", Date.now());
      if (!first) return false;
      await redis
        .multi()
        .del(kUser(c.a.userId), kUser(c.b.userId))
        .expire(kChat(c.id), ENDED_KEEP_S)
        .expire(kLog(c.id), ENDED_KEEP_S)
        .exec();
      return true;
    },

    /** Returns true the first time a client message id is seen, false for a retry. */
    async firstDelivery(chatId: string, clientMsgId: string): Promise<boolean> {
      return (await redis.set(`chat:${chatId}:dup:${clientMsgId}`, "1", "EX", 300, "NX")) === "OK";
    },

    async append(c: Chat, from: ChatSide, clientMsgId: string, text: string, replyTo?: ReplyPreview): Promise<ChatMessage> {
      const seq = await redis.hincrby(kChat(c.id), "seq", 1);
      const msg: ChatMessage = {
        id: randomUUID(), roomId: c.id, clientMsgId, seq, alias: from.alias,
        gender: from.gender, age: from.age, text, at: Date.now(), ...(replyTo ? { replyTo } : {}),
      };
      await redis.multi().rpush(kLog(c.id), JSON.stringify(msg)).ltrim(kLog(c.id), -LOG_MAX, -1).exec();
      onMessage?.(c, from, msg);
      return msg;
    },

    async findMessage(chatId: string, id: string): Promise<ChatMessage | null> {
      return (await this.since(chatId, 0)).find((m) => m.id === id) ?? null;
    },

    async since(chatId: string, lastSeq: number): Promise<ChatMessage[]> {
      const all = (await redis.lrange(kLog(chatId), 0, -1)).map((x) => JSON.parse(x) as ChatMessage);
      return all.filter((m) => m.seq > lastSeq);
    },

    /** Last words from one person, kept with a report for human review. */
    async evidenceFrom(chatId: string, alias: string, n = 15): Promise<string | null> {
      const msgs = (await this.since(chatId, 0)).filter((m) => m.alias === alias).slice(-n);
      return msgs.length ? msgs.map((m) => m.text).join("\n---\n") : null;
    },
  };
}
export type ChatStore = ReturnType<typeof chatStore>;
