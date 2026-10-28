import type { RedisClient } from "../../lib/redis";
import { getSimulatedOnlineCount } from "../simulation/online.simulator";

const KEY = "presence:users";
/** A user counts as online if we heard from them in the last minute. Survives server crashes. */
const FRESH_MS = 60_000;

export function presenceService(redis: RedisClient) {
  return {
    touch: (userId: string) => redis.zadd(KEY, Date.now(), userId),
    remove: (userId: string) => redis.zrem(KEY, userId),
    async realCount(): Promise<number> {
      const cutoff = Date.now() - FRESH_MS;
      await redis.zremrangebyscore(KEY, "-inf", cutoff);
      return redis.zcount(KEY, cutoff, "+inf");
    },
    async count(): Promise<number> {
      const real = await this.realCount();
      return getSimulatedOnlineCount(redis, real);
    },
    async isOnline(userId: string): Promise<boolean> {
      const s = await redis.zscore(KEY, userId);
      return s !== null && Date.now() - Number(s) < FRESH_MS;
    },
  };
}
export type PresenceService = ReturnType<typeof presenceService>;
