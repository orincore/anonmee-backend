import type { RedisClient } from "./redis";

/**
 * Failed-login throttle that survives IP rotation. Two counters:
 *  - per email + IP: 5 failures / 15 min, stops one attacker guessing at an account
 *  - per email alone: 20 failures / 15 min, stops a botnet spreading guesses across IPs
 * Counters are keyed by a hash-free lowercase email; Redis holds nothing but counts.
 */
const WINDOW_S = 15 * 60;
const PER_PAIR = 5;
const PER_EMAIL = 20;

export interface LoginThrottle {
  isLocked(email: string, ip: string): Promise<boolean>;
  fail(email: string, ip: string): Promise<void>;
  succeed(email: string, ip: string): Promise<void>;
}

export function loginThrottle(redis: RedisClient): LoginThrottle {
  const pair = (e: string, ip: string) => `thr:login:pair:${e}:${ip}`;
  const mail = (e: string) => `thr:login:email:${e}`;
  return {
    async isLocked(email, ip) {
      const [p, e] = await redis.mget(pair(email, ip), mail(email));
      return Number(p ?? 0) >= PER_PAIR || Number(e ?? 0) >= PER_EMAIL;
    },
    async fail(email, ip) {
      const m = redis.multi();
      for (const k of [pair(email, ip), mail(email)]) m.incr(k).expire(k, WINDOW_S, "NX");
      await m.exec();
    },
    async succeed(email, ip) {
      await redis.del(pair(email, ip));
    },
  };
}
