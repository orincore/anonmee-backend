import type { ChatMessage } from "../../contracts";
import type { RedisClient } from "../../lib/redis";

const TTL_S = 7 * 24 * 3600; // same lifetime as group messages
const kCounts = (room: string, msg: string) => `react:${room}:${msg}`;
const kMine = (room: string, msg: string, user: string) => `reacted:${room}:${msg}:${user}`;

/** One reaction per person per emoji per message: a second tap on the same emoji takes it back. Atomic. */
const TOGGLE_LUA = `
local added = redis.call('SADD', KEYS[2], ARGV[1])
if added == 1 then
  redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
else
  redis.call('SREM', KEYS[2], ARGV[1])
  local n = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
  if n <= 0 then redis.call('HDEL', KEYS[1], ARGV[1]) end
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return added`;

export class ReactionError extends Error {
  constructor(readonly code: "rate_limited", message: string) {
    super(message);
  }
}

/** Emoji reactions for any room (one-to-one chats and groups alike). Stores counts and who-reacted sets in Redis only. */
export function reactionsService(redis: RedisClient) {
  const counts = async (room: string, msg: string) => {
    const h = await redis.hgetall(kCounts(room, msg));
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Number(v)]));
  };

  return {
    async toggle(room: string, msg: string, user: string, emoji: string) {
      const n = await redis.incr(`rate:react:${user}`);
      if (n === 1) await redis.expire(`rate:react:${user}`, 60);
      if (n > 60) throw new ReactionError("rate_limited", "Slow down a little.");
      const added = await redis.eval(TOGGLE_LUA, 2, kCounts(room, msg), kMine(room, msg, user), emoji, TTL_S);
      return { mine: added === 1, reactions: await counts(room, msg) };
    },

    /** Adds reaction counts and the viewer's own reactions to a batch of messages, in two round trips. */
    async attach(room: string, messages: ChatMessage[], viewer: string): Promise<ChatMessage[]> {
      if (messages.length === 0) return messages;
      const p = redis.pipeline();
      for (const m of messages) p.hgetall(kCounts(room, m.id)).smembers(kMine(room, m.id, viewer));
      const res = (await p.exec()) ?? [];
      return messages.map((m, i) => {
        const h = (res[i * 2]?.[1] ?? {}) as Record<string, string>;
        const mine = (res[i * 2 + 1]?.[1] ?? []) as string[];
        const reactions = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Number(v)]));
        return Object.keys(reactions).length || mine.length ? { ...m, reactions, mine } : m;
      });
    },
  };
}
export type ReactionsService = ReturnType<typeof reactionsService>;
