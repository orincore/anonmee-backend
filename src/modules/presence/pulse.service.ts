import type { PulseEvent } from "../../contracts";
import type { RedisClient } from "../../lib/redis";

const KEY = "pulse:recent";
const KEEP = 12;
const TTL_S = 6 * 3600;

/**
 * A short public feed of what is happening right now, for the landing page ticker.
 * It carries no user information: a match says only which kind of chat it was, a group says its public title.
 * Events older than six hours drop out, so the ticker never shows stale activity.
 */
export function pulseService(redis: RedisClient) {
  return {
    async record(e: PulseEvent): Promise<void> {
      await redis.multi().lpush(KEY, JSON.stringify(e)).ltrim(KEY, 0, KEEP - 1).expire(KEY, TTL_S).exec();
    },
    async recent(): Promise<PulseEvent[]> {
      const cutoff = Date.now() - TTL_S * 1000;
      return (await redis.lrange(KEY, 0, KEEP - 1)).map((x) => JSON.parse(x) as PulseEvent).filter((e) => e.at > cutoff);
    },
  };
}
export type PulseService = ReturnType<typeof pulseService>;
