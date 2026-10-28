import type { RedisClient } from "../../lib/redis";

const KEY_COUNT = "sim:online:count";
const KEY_TICK = "sim:online:tick";
const MIN_ONLINE = 34;
const MAX_ONLINE = 97;

/**
 * Natural fluctuation generator for online users:
 * - Keeps count strictly in the 30 to 100 range (currently under 100).
 * - Uses smooth Brownian random walk with mean reversion so numbers never jump abruptly.
 * - Simulates realistic diurnal (day/night) curve (higher active presence in evening & night).
 */
export async function getSimulatedOnlineCount(redis: RedisClient, realCount: number): Promise<number> {
  try {
    const now = Date.now();
    const [rawCount, rawTick] = await redis.mget(KEY_COUNT, KEY_TICK);

    let current = rawCount ? Number(rawCount) : 0;
    const lastTick = rawTick ? Number(rawTick) : 0;

    // Initialize if empty or invalid
    if (!current || isNaN(current) || current < MIN_ONLINE || current > MAX_ONLINE) {
      current = Math.floor(MIN_ONLINE + Math.random() * (MAX_ONLINE - MIN_ONLINE));
      await redis.set(KEY_COUNT, current, "EX", 86400);
      await redis.set(KEY_TICK, now, "EX", 86400);
    }

    // Update every 3 to 6 seconds for realistic drift
    if (now - lastTick > 3500) {
      // Determine time-of-day target mean (higher at night IST, e.g. 65-80, afternoon 50-65)
      const currentHour = new Date().getUTCHours(); // UTC hour
      // UTC 14:00 - 20:00 is ~7:30 PM - 1:30 AM IST (peak hours)
      const isPeakHours = currentHour >= 14 && currentHour <= 21;
      const targetMean = isPeakHours ? 74 : 54;

      // Mean reversion pull: pulls gently toward targetMean
      const pull = (targetMean - current) * 0.08;

      // Random step between -2, -1, 0, 1, 2 with weighted probability
      const randomJitter = (Math.random() - 0.5) * 3.2;

      const delta = Math.round(pull + randomJitter);
      let next = current + delta;

      // Clamp strictly within bounds
      if (next < MIN_ONLINE) next = MIN_ONLINE + Math.floor(Math.random() * 3);
      if (next > MAX_ONLINE) next = MAX_ONLINE - Math.floor(Math.random() * 3);

      current = next;

      await redis.multi()
        .set(KEY_COUNT, current, "EX", 86400)
        .set(KEY_TICK, now, "EX", 86400)
        .exec();
    }

    // Add real connected users while ensuring we stay strictly under 100
    const total = current + (realCount > 0 ? realCount : 0);
    return Math.min(MAX_ONLINE, Math.max(MIN_ONLINE, total));
  } catch (err) {
    // Graceful fallback if Redis encounters any transient error
    return Math.floor(48 + Math.random() * 25);
  }
}
