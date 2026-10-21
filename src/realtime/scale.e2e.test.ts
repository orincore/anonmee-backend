import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, queryStats } from "../db/client";
import { groups, roomMessages } from "../db/schema";
import { redis } from "../lib/redis";
import { cleanTag, connected, emitAck, makeUser, openSocket, startTestServer, type TestUser } from "../test/helpers";

const TAG = "e2es";
let srv: Awaited<ReturnType<typeof startTestServer>>;
const all: TestUser[] = [];
const live = async (n: string, o?: Parameters<typeof makeUser>[3]) => {
  const u = await makeUser(srv.app, TAG, n, o);
  all.push(u);
  await connected(openSocket(srv.url, u));
  return u;
};
const pctl = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await cleanTag(TAG);
  await db.delete(roomMessages);
  srv = await startTestServer();
});
afterAll(async () => {
  all.forEach((u) => u.socket?.disconnect());
  for (const u of all) await db.delete(groups).where(eq(groups.ownerId, u.userId));
  await cleanTag(TAG);
  await srv.app.close();
});

describe("real time feel", () => {
  it("1:1 chat: messages arrive fast, in order, with no gaps", async () => {
    const prefs = { intents: ["other"], wantGenders: ["male", "female"], minAge: 18, maxAge: 99, interests: [] };
    const a = await live("p1a", { prefs });
    const b = await live("p1b", { prefs });
    const found = new Promise<{ chatId: string }>((r) => a.socket!.once("match:found", r));
    await emitAck(a.socket!, "match:join");
    await emitAck(b.socket!, "match:join");
    const { chatId } = await found;

    const lat: number[] = [];
    const seqs: number[] = [];
    const sentAt = new Map<string, number>();
    b.socket!.on("chat:message", (m: { clientMsgId: string; seq: number }) => {
      seqs.push(m.seq);
      lat.push(performance.now() - sentAt.get(m.clientMsgId)!);
    });
    for (let i = 0; i < 60; i++) {
      const id = `lat-msg-${String(i).padStart(4, "0")}`;
      sentAt.set(id, performance.now());
      await emitAck(a.socket!, "chat:message", { roomId: chatId, clientMsgId: id, text: `m${i}` });
      await sleep(130); // a fast human, below the abuse limiter
    }
    await sleep(200);
    expect(seqs).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(pctl(lat, 0.95)).toBeLessThan(50);
  }, 30_000);

  it("global room: 60 listeners all receive a message quickly", async () => {
    const crowd = await Promise.all(Array.from({ length: 60 }, (_, i) => live(`crowd${i}`)));
    await Promise.all(crowd.map((u) => emitAck(u.socket!, "room:join", { roomId: "global" })));
    const t0 = performance.now();
    const lat: number[] = [];
    crowd.slice(1).forEach((u) => u.socket!.on("room:message", () => lat.push(performance.now() - t0)));
    await emitAck(crowd[0]!.socket!, "room:message", { roomId: "global", clientMsgId: "crowd-msg-0001", text: "hello everyone" });
    await sleep(500);
    expect(lat).toHaveLength(59);
    expect(Math.max(...lat)).toBeLessThan(250);
  }, 60_000);
});

describe("database stays quiet", () => {
  it("300 messages from 30 people cost a handful of queries, not 300", async () => {
    const people = await Promise.all(Array.from({ length: 30 }, (_, i) => live(`load${i}`)));
    const created = await srv.app.inject({ method: "POST", url: "/groups", payload: { title: "Load test", topic: "loadtest", description: "" }, headers: { cookie: people[0]!.cookie, "idempotency-key": "load-key-0001" } });
    const gid = created.json().group.id;
    await Promise.all(people.slice(1).map((p) => srv.app.inject({ method: "POST", url: `/groups/${gid}/join`, headers: { cookie: p.cookie } })));
    await Promise.all(people.map((p) => emitAck(p.socket!, "room:join", { roomId: gid })));
    await sleep(600);

    const before = queryStats.count;
    let n = 0;
    for (let round = 0; round < 10; round++) {
      await Promise.all(people.map((p) => emitAck(p.socket!, "room:message", { roomId: gid, clientMsgId: `load-${round}-${n++}-${p.userId.slice(0, 8)}`, text: "hi" })));
      await sleep(1050); // stay under the per-person flood limit
    }
    await sleep(600);
    const used = queryStats.count - before;
    expect(used).toBeLessThan(80); // ~1 batched insert per flush tick, not one per message
    const [{ n: saved }] = (await db.select({ n: sql`count(*)::int` }).from(roomMessages).where(eq(roomMessages.roomId, gid))) as [{ n: number }];
    expect(saved).toBe(300);
  }, 120_000);
});

describe("history", () => {
  it("scroll-back pages walk the whole history with no repeats or gaps", async () => {
    const u = await live("hist1");
    const gid = (await srv.app.inject({ method: "POST", url: "/groups", payload: { title: "History test", topic: "history", description: "" }, headers: { cookie: u.cookie, "idempotency-key": "hist-key-0001" } })).json().group.id;
    const join = await emitAck(u.socket!, "room:join", { roomId: gid });
    expect(join.messages).toEqual([]);
    // Seed 130 saved messages directly: this test is about reading, not sending.
    await db.insert(roomMessages).values(Array.from({ length: 130 }, (_, i) => ({
      roomId: gid, seq: i + 1, clientMsgId: `seed-${i}`, userId: u.userId, alias: join.alias, gender: "female" as const, age: 25, text: `msg ${i + 1}`,
    })));
    await redis.del(`room:${gid}:seq`);
    await redis.del(`room:${gid}:recent`); // cold cache: everything is read from Postgres

    const first = await emitAck(u.socket!, "room:join", { roomId: gid });
    expect(first.messages).toHaveLength(50);
    expect(first.messages[49].seq).toBe(130);
    expect(first.hasMore).toBe(true);

    const seen = first.messages.map((m: { seq: number }) => m.seq);
    let cursor = first.messages[0].seq;
    for (let guard = 0; guard < 10; guard++) {
      const page = await emitAck(u.socket!, "room:history", { roomId: gid, beforeSeq: cursor, limit: 50 });
      expect(page.ok).toBe(true);
      if (page.messages.length === 0) break;
      seen.unshift(...page.messages.map((m: { seq: number }) => m.seq));
      cursor = page.messages[0].seq;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(Array.from({ length: 130 }, (_, i) => i + 1));
  }, 120_000);

  it("a stranger cannot page through a group's history", async () => {
    const owner = await live("hist2o");
    const stranger = await live("hist2x");
    const gid = (await srv.app.inject({ method: "POST", url: "/groups", payload: { title: "Private history", topic: "history", description: "" }, headers: { cookie: owner.cookie, "idempotency-key": "hist-key-0002" } })).json().group.id;
    expect((await emitAck(stranger.socket!, "room:history", { roomId: gid, beforeSeq: 10, limit: 20 })).error).toBe("not_member");
    expect((await emitAck(stranger.socket!, "room:history", { roomId: gid, beforeSeq: 0 })).error).toBe("invalid");
  });

  it("member lists are paged", async () => {
    const owner = await live("mem0");
    const gid = (await srv.app.inject({ method: "POST", url: "/groups", payload: { title: "Members paging", topic: "memberpaging", description: "" }, headers: { cookie: owner.cookie, "idempotency-key": "mem-key-00001" } })).json().group.id;
    const joiners = await Promise.all(Array.from({ length: 7 }, (_, i) => makeUser(srv.app, TAG, `memj${i}`)));
    for (const j of joiners) await srv.app.inject({ method: "POST", url: `/groups/${gid}/join`, headers: { cookie: j.cookie } });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const r: any = (await srv.app.inject({ method: "GET", url: `/groups/${gid}/members?limit=3${cursor ? `&cursor=${cursor}` : ""}`, headers: { cookie: owner.cookie } })).json();
      seen.push(...r.members.map((m: { alias: string }) => m.alias));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  }, 30_000);
});
