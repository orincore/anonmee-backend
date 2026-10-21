import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import type { RedisClient } from "../../lib/redis";

export const ROOM_MESSAGE_DAYS = 7;
export const REPORT_EVIDENCE_DAYS = 30;
export const VISIT_DAYS = 400;

/** Deletes in slices so a big purge never holds a long lock or spikes the database. */
async function purge(db: Db, table: string, where: string, slice = 5000): Promise<number> {
  let total = 0;
  for (let i = 0; i < 200; i++) {
    const res = await db.execute(sql.raw(`delete from ${table} where ctid in (select ctid from ${table} where ${where} limit ${slice})`));
    const n = Number((res as unknown as { count?: number }).count ?? 0);
    total += n;
    if (n < slice) break;
  }
  return total;
}

/** Runs the privacy and housekeeping cleanup. Safe to call from every server: only one runs at a time. */
export async function runRetention(db: Db, redis: RedisClient) {
  const lock = randomUUID();
  if ((await redis.set("maintenance:retention", lock, "EX", 600, "NX")) !== "OK") return null;
  try {
    const messages = await purge(db, "room_messages", `created_at < now() - interval '${ROOM_MESSAGE_DAYS} days'`);
    const tokens = await purge(db, "refresh_tokens", `expires_at < now() - interval '1 day' or revoked_at < now() - interval '1 day'`);
    const visitsGone = await purge(db, "visits", `created_at < now() - interval '${VISIT_DAYS} days'`);
    // Evidence is only for review. Once a report is closed, the words are not kept.
    const ev = await db.execute(sql.raw(`update reports set evidence = null where evidence is not null and status <> 'open' and created_at < now() - interval '${REPORT_EVIDENCE_DAYS} days'`));
    return { messages, tokens, visits: visitsGone, evidenceCleared: Number((ev as unknown as { count?: number }).count ?? 0) };
  } finally {
    if ((await redis.get("maintenance:retention")) === lock) await redis.del("maintenance:retention");
  }
}
