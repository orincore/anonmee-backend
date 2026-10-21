import type { RedisClient } from "./redis";

/**
 * "How busy is this room right now" without touching Postgres. Each message bumps a counter in
 * a one-minute bucket (a Redis hash per minute). Reading the last 10 buckets gives the 10 minute
 * message count for every room in one pipelined call.
 */
const BUCKETS = 10;
const bucket = (t = Date.now()) => Math.floor(t / 60_000);
const key = (b: number) => `act:${b}`;

export async function recordActivity(redis: RedisClient, roomId: string): Promise<void> {
  const k = key(bucket());
  await redis.multi().hincrby(k, roomId, 1).expire(k, (BUCKETS + 2) * 60).exec();
}

export async function activityFor(redis: RedisClient, roomIds: string[]): Promise<Map<string, number>> {
  const now = bucket();
  const p = redis.pipeline();
  for (let i = 0; i < BUCKETS; i++) p.hmget(key(now - i), ...roomIds);
  const res = await p.exec();
  const out = new Map<string, number>(roomIds.map((id) => [id, 0]));
  if (roomIds.length === 0) return out;
  for (const [, row] of res ?? []) {
    (row as (string | null)[]).forEach((v, i) => {
      if (v) out.set(roomIds[i]!, (out.get(roomIds[i]!) ?? 0) + Number(v));
    });
  }
  return out;
}
