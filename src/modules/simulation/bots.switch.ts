import { env } from "../../config/env";
import type { RedisClient } from "../../lib/redis";

const KEY = "bots:switch";
const CACHE_MS = 3000;

/**
 * Runtime on/off for every AI user, flipped by the owner in the admin console. `BOTS_ENABLED=false` in the environment
 * still wins (hard kill); this switch can only turn things off when the environment allows them. Cached for a few seconds
 * so hot paths do not hit Redis, and shared through Redis so every server process agrees.
 */
export class BotSwitch {
  private cached: { at: number; on: boolean } | null = null;

  constructor(private redis: RedisClient) {}

  public async isOn(): Promise<boolean> {
    if (!env.BOTS_ENABLED) return false;
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.on;
    // Redis trouble must not silently turn the AI off or on: keep the last known answer, default on.
    const on = await this.redis.get(KEY).then((v) => v !== "off").catch(() => this.cached?.on ?? true);
    this.cached = { at: Date.now(), on };
    return on;
  }

  public async set(on: boolean): Promise<void> {
    await this.redis.set(KEY, on ? "on" : "off");
    this.cached = { at: Date.now(), on };
  }
}

let shared: BotSwitch | null = null;
/** One switch per process, created on first use with the app's Redis client. */
export function botSwitch(redis: RedisClient): BotSwitch {
  return (shared ??= new BotSwitch(redis));
}
