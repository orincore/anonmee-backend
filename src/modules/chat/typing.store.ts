import type { RedisClient } from "../../lib/redis";

const TTL_MS = 3500;
const ROOM_TTL_S = 10;

const kSet = (roomId: string) => `typing:room:${roomId}`;
const kHash = (roomId: string) => `typing:hash:${roomId}`;

/** Redis-backed typing presence. One sorted set per room holds userId scored by expiry timestamp. */
export function typingStore(redis: RedisClient) {
  return {
    async mark(roomId: string, userId: string, alias: string): Promise<string[]> {
      const exp = Date.now() + TTL_MS;
      const setKey = kSet(roomId);
      const hashKey = kHash(roomId);
      await redis
        .multi()
        .zadd(setKey, exp, userId)
        .hset(hashKey, { [userId]: alias })
        .expire(setKey, ROOM_TTL_S)
        .expire(hashKey, ROOM_TTL_S)
        .exec();
      return this.list(roomId);
    },

    async clear(roomId: string, userId: string): Promise<string[]> {
      await redis.multi().zrem(kSet(roomId), userId).hdel(kHash(roomId), userId).exec();
      return this.list(roomId);
    },

    /** Current typists as aliases, pruned of expired entries first. */
    async list(roomId: string): Promise<string[]> {
      const setKey = kSet(roomId);
      const hashKey = kHash(roomId);
      const now = Date.now();
      await redis.zremrangebyscore(setKey, 0, now);
      const members: string[] = await redis.zrange(setKey, 0, -1);
      if (members.length === 0) return [];
      const aliases = await redis.hmget(hashKey, ...members);
      const out: string[] = [];
      const stale: string[] = [];
      members.forEach((m, i) => {
        const a = aliases[i];
        if (a) out.push(a);
        else stale.push(m);
      });
      if (stale.length) await redis.hdel(hashKey, ...stale);
      return out;
    },
  };
}
export type TypingStore = ReturnType<typeof typingStore>;
