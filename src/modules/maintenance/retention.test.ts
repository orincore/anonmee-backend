import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { startTestServer, makeUser, cleanTag } from "../../test/helpers";
import { db } from "../../db/client";
import { redis } from "../../lib/redis";
import { reports, roomMessages } from "../../db/schema";
import { runRetention } from "./retention";

const TAG = "rett";
let srv: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => { await cleanTag(TAG); srv = await startTestServer(); });
afterAll(async () => { await cleanTag(TAG); await srv.app.close(); });

describe("retention", () => {
  it("removes chat older than 7 days, keeps recent chat, clears closed-report evidence, and never runs twice at once", async () => {
    const u = await makeUser(srv.app, TAG, "a");
    const w = await makeUser(srv.app, TAG, "b");
    const old = new Date(Date.now() - 8 * 86_400_000);
    const row = (seq: number, at: Date) => ({ roomId: "ret-room", seq, clientMsgId: `ret-${seq}`, userId: u.userId, alias: "Old Fox 11", gender: "male" as const, age: 30, text: "x", createdAt: at });
    await db.insert(roomMessages).values([row(1, old), row(2, old), row(3, new Date())]);
    const [closed] = await db.insert(reports).values({ reporterId: u.userId, reportedId: w.userId, reason: "spam", evidence: "words", status: "actioned", createdAt: new Date(Date.now() - 40 * 86_400_000) }).returning();
    const [open] = await db.insert(reports).values({ reporterId: u.userId, reportedId: w.userId, reason: "spam", evidence: "keep me", status: "open", createdAt: new Date(Date.now() - 40 * 86_400_000) }).returning();

    await redis.set("maintenance:retention", "someone-else", "EX", 60);
    expect(await runRetention(db, redis)).toBeNull(); // another server is already running it
    await redis.del("maintenance:retention");

    const out = await runRetention(db, redis);
    expect(out!.messages).toBeGreaterThanOrEqual(2);
    expect((await db.select().from(roomMessages).where(eq(roomMessages.roomId, "ret-room"))).map((r) => r.seq)).toEqual([3]);
    expect((await db.select().from(reports).where(eq(reports.id, closed!.id)))[0]!.evidence).toBeNull();
    expect((await db.select().from(reports).where(eq(reports.id, open!.id)))[0]!.evidence).toBe("keep me");
    await db.delete(roomMessages).where(like(roomMessages.roomId, "ret-%"));
  });

  it("online counter endpoint is public and cheap", async () => {
    const res = await srv.app.inject({ method: "GET", url: "/stats/online" });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().count).toBe("number");
    expect(Object.keys(res.json())).toEqual(["count"]);
    expect(res.headers["cache-control"]).toContain("max-age=5");
  });
});

describe("live pulse", () => {
  it("shows what is happening without revealing who", async () => {
    const { pulseService } = await import("../presence/pulse.service");
    const p = pulseService(redis);
    await redis.del("pulse:recent", "stats:pulse");
    await p.record({ kind: "match", intent: "friendship", at: Date.now() });
    await p.record({ kind: "group", title: "Late night talks", topic: "late-night-talks", at: Date.now() });
    await p.record({ kind: "match", intent: "casual_dating", at: Date.now() - 7 * 3600_000 }); // too old: dropped
    const res = await srv.app.inject({ method: "GET", url: "/stats/pulse" });
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["chatsToday", "events", "online"]);
    expect(body.events).toHaveLength(2);
    expect(JSON.stringify(body)).not.toMatch(/userId|alias|email|username/i);
    expect(res.headers["cache-control"]).toContain("max-age=3");
    await redis.del("pulse:recent", "stats:pulse");
  });
});
