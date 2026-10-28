import type { RedisClient } from "../../lib/redis";

const KEY_COUNT = "sim:online:count";
const KEY_TICK = "sim:online:tick";
const MIN_ONLINE = 30;
const MAX_ONLINE = 99;
const TICK_MS = 3500;

/** The count's long-run target at a moment: a day curve (busiest around 10 pm IST) plus two slow waves, so it wanders instead of hovering. */
export function onlineTarget(nowMs: number): number {
  const istHour = (new Date(nowMs).getUTCHours() + 5.5 + new Date(nowMs).getUTCMinutes() / 60) % 24;
  const day = 62 + 16 * Math.cos(((istHour - 22) / 24) * 2 * Math.PI); // 46 in the morning, 78 at night
  const minutes = nowMs / 60_000;
  const waves = 11 * Math.sin(minutes / 23) + 7 * Math.sin(minutes / 6.5 + 1.3); // slow swells and quick surges
  return Math.min(MAX_ONLINE - 6, Math.max(MIN_ONLINE + 8, day + waves));
}

/** A step that is mostly small, sometimes a real jump, now and then a big one (people arriving in a rush, or leaving together). */
export function onlineStep(rng: () => number = Math.random): number {
  const r = rng();
  const size = r < 0.5 ? 1 + Math.floor(rng() * 2) : r < 0.82 ? 3 + Math.floor(rng() * 3) : r < 0.97 ? 6 + Math.floor(rng() * 4) : 10 + Math.floor(rng() * 5);
  return rng() < 0.5 ? -size : size;
}

/** The next value from the current one. Never stays put, never leaves 30 to 99. Pure, unit tested. */
export function nextOnline(current: number, nowMs: number, rng: () => number = Math.random): number {
  const pull = (onlineTarget(nowMs) - current) * 0.1; // a gentle lean towards the target, so it does not wander off for good
  let delta = Math.max(-15, Math.min(15, Math.round(pull + onlineStep(rng)))); // one refresh never jumps further than this
  if (delta === 0) delta = rng() < 0.5 ? -1 : 1; // a count that sits still looks dead
  const next = current + delta;
  if (next < MIN_ONLINE) return MIN_ONLINE + 1 + Math.floor(rng() * 4);
  if (next > MAX_ONLINE) return MAX_ONLINE - 1 - Math.floor(rng() * 4);
  return next;
}

/**
 * Online users shown to people: a simulated crowd that drifts the way a real one does, plus the real people connected.
 * Always between 30 and 99.
 */
export async function getSimulatedOnlineCount(redis: RedisClient, realCount: number): Promise<number> {
  try {
    const now = Date.now();
    const [rawCount, rawTick] = await redis.mget(KEY_COUNT, KEY_TICK);

    let current = rawCount ? Number(rawCount) : 0;
    const lastTick = rawTick ? Number(rawTick) : 0;

    // Start from somewhere plausible if there is nothing stored.
    if (!current || isNaN(current) || current < MIN_ONLINE || current > MAX_ONLINE) {
      current = Math.round(onlineTarget(now));
      await redis.set(KEY_COUNT, current, "EX", 86400);
      await redis.set(KEY_TICK, now, "EX", 86400);
    }

    if (now - lastTick > TICK_MS) {
      current = nextOnline(current, now);
      await redis.multi().set(KEY_COUNT, current, "EX", 86400).set(KEY_TICK, now, "EX", 86400).exec();
    }

    const total = current + (realCount > 0 ? realCount : 0);
    return Math.min(MAX_ONLINE, Math.max(MIN_ONLINE, total));
  } catch {
    // Graceful fallback if Redis has a transient error
    return Math.floor(48 + Math.random() * 25);
  }
}
