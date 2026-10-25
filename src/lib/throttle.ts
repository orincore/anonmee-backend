import type { RedisClient } from "./redis";

export interface LoginThrottle {
  isLocked(email: string, ip: string): Promise<boolean>;
  fail(email: string, ip: string): Promise<void>;
  succeed(email: string, ip: string): Promise<void>;
}

/** Login throttle disabled per user request: no 15-minute lockouts. */
export function loginThrottle(_redis: RedisClient): LoginThrottle {
  return {
    async isLocked() {
      return false;
    },
    async fail() {},
    async succeed() {},
  };
}
