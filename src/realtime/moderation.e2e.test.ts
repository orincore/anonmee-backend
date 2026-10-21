import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { blocks, groups, reports, users } from "../db/schema";
import { redis } from "../lib/redis";
import { cleanTag, connected, emitAck, makeUser, once, openSocket, startTestServer, type TestUser } from "../test/helpers";

const TAG = "e2ex";
let srv: Awaited<ReturnType<typeof startTestServer>>;
const all: TestUser[] = [];
const prefs = { intents: ["friendship"], wantGenders: ["male", "female"], minAge: 18, maxAge: 99, interests: [] };
const live = async (n: string) => {
  const u = await makeUser(srv.app, TAG, n, { prefs, gender: n.startsWith("a") ? "female" : "male" });
  all.push(u);
  await connected(openSocket(srv.url, u));
  return u;
};
const api = (u: TestUser, method: string, url: string, payload?: unknown) =>
  srv.app.inject({ method: method as "GET", url, payload: payload as object, headers: { cookie: u.cookie } });
async function pair(a: TestUser, b: TestUser) {
  const fa = once(a.socket!, "match:found");
  const fb = once(b.socket!, "match:found");
  await emitAck(a.socket!, "match:join");
  await emitAck(b.socket!, "match:join");
  return { ma: await fa, mb: await fb };
}

beforeAll(async () => {
  await cleanTag(TAG);
  srv = await startTestServer();
});
afterAll(async () => {
  all.forEach((u) => u.socket?.disconnect());
  for (const u of all) await db.delete(groups).where(eq(groups.ownerId, u.userId));
  await cleanTag(TAG);
  await srv.app.close();
});

describe("report and block", () => {
  it("reporting ends the chat for both, saves evidence, and they are never matched again", async () => {
    const a = await live("a1");
    const b = await live("b1");
    const { ma } = await pair(a, b);
    await emitAck(b.socket!, "chat:message", { roomId: ma.chatId, clientMsgId: "evidence-msg-01", text: "something rude" });
    const aEnded = once(a.socket!, "chat:end");
    const bEnded = once(b.socket!, "chat:end");
    const res = await api(a, "POST", "/moderation/report", { roomId: ma.chatId, alias: ma.peer.alias, reason: "harassment", details: "rude", alsoBlock: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await Promise.all([aEnded, bEnded]);

    const [row] = await db.select().from(reports).where(eq(reports.reporterId, a.userId));
    expect(row?.reportedId).toBe(b.userId);
    expect(row?.evidence).toContain("something rude");
    expect(row?.reason).toContain("harassment");

    // Even after the 10 minute cooldown is gone, the block keeps them apart.
    await redis.del(`mm:recent:${a.userId}`, `mm:recent:${b.userId}`);
    let rematched = false;
    for (const u of [a, b]) u.socket!.on("match:found", () => (rematched = true));
    await emitAck(a.socket!, "match:join");
    await emitAck(b.socket!, "match:join");
    await new Promise((r) => setTimeout(r, 2500));
    expect(rematched).toBe(false);
    await emitAck(a.socket!, "match:leave");
    await emitAck(b.socket!, "match:leave");
  });

  it("report even with the 'also block' box unticked still blocks", async () => {
    const a = await live("a2");
    const b = await live("b2");
    const { ma } = await pair(a, b);
    await api(a, "POST", "/moderation/report", { roomId: ma.chatId, alias: ma.peer.alias, reason: "spam", alsoBlock: false });
    const rows = await db.select().from(blocks).where(eq(blocks.blockerId, a.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.alias).toBe(ma.peer.alias);
  });

  it("an underage report bans the account at once and cuts it off", async () => {
    const a = await live("a3");
    const b = await live("b3");
    const { ma } = await pair(a, b);
    const cut = new Promise<void>((r) => b.socket!.once("disconnect", () => r()));
    await api(a, "POST", "/moderation/report", { roomId: ma.chatId, alias: ma.peer.alias, reason: "underage" });
    await cut;
    const [u] = await db.select().from(users).where(eq(users.id, b.userId));
    expect(u?.bannedAt).not.toBeNull();
    const login = await srv.app.inject({ method: "POST", url: "/auth/login", payload: { email: `${TAG}-b3@example.com`, password: "correct horse 9" } });
    expect(login.statusCode).toBe(403);
  });

  it("block in 1:1 ends the chat; the blocked list shows aliases only and can be undone", async () => {
    const a = await live("a4");
    const b = await live("b4");
    const { ma } = await pair(a, b);
    const ended = once(b.socket!, "chat:end");
    expect((await api(a, "POST", "/moderation/block", { roomId: ma.chatId, alias: ma.peer.alias })).statusCode).toBe(200);
    await ended;
    const list = (await api(a, "GET", "/moderation/blocks")).json().blocks;
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(["alias", "at", "id"]);
    expect(list[0].alias).toBe(ma.peer.alias);
    await api(a, "DELETE", `/moderation/blocks/${list[0].id}`);
    expect((await api(a, "GET", "/moderation/blocks")).json().blocks).toHaveLength(0);
  });

  it("you cannot report someone who was never in your room, or yourself, or as a stranger", async () => {
    const a = await live("a5");
    const b = await live("b5");
    const stranger = await live("b6");
    const { ma } = await pair(a, b);
    expect((await api(a, "POST", "/moderation/report", { roomId: ma.chatId, alias: "Nobody Here 00", reason: "spam" })).statusCode).toBe(404);
    expect((await api(a, "POST", "/moderation/report", { roomId: ma.chatId, alias: ma.you.alias, reason: "spam" })).statusCode).toBe(404);
    expect((await api(stranger, "POST", "/moderation/report", { roomId: ma.chatId, alias: ma.peer.alias, reason: "spam" })).statusCode).toBe(404);
    expect((await api(stranger, "POST", "/moderation/block", { roomId: ma.chatId, alias: ma.peer.alias })).statusCode).toBe(404);
    expect((await api(a, "POST", "/moderation/report", { roomId: ma.chatId, alias: ma.peer.alias, reason: "made-up" })).statusCode).toBe(400);
    expect((await srv.app.inject({ method: "POST", url: "/moderation/block", payload: {} })).statusCode).toBe(401);
  });

  it("works in groups and global chat too", async () => {
    const owner = await live("a7");
    const member = await live("b7");
    const created = await srv.app.inject({ method: "POST", url: "/groups", payload: { title: "Moderation test", topic: "testing", description: "" }, headers: { cookie: owner.cookie, "idempotency-key": "mod-group-key-1" } });
    const gid = created.json().group.id;
    const joined = await api(member, "POST", `/groups/${gid}/join`);
    await emitAck(owner.socket!, "room:join", { roomId: gid });
    await emitAck(member.socket!, "room:join", { roomId: gid });
    await emitAck(member.socket!, "room:message", { roomId: gid, clientMsgId: "mod-room-msg-01", text: "bad words" });
    const res = await api(owner, "POST", "/moderation/report", { roomId: gid, alias: joined.json().alias, reason: "inappropriate" });
    expect(res.statusCode).toBe(200);
    const [r] = await db.select().from(reports).where(eq(reports.reporterId, owner.userId));
    expect(r?.reportedId).toBe(member.userId);
    expect(r?.evidence).toContain("bad words");
    // Global
    const ga = await emitAck(owner.socket!, "room:join", { roomId: "global" });
    const gb = await emitAck(member.socket!, "room:join", { roomId: "global" });
    expect((await api(owner, "POST", "/moderation/block", { roomId: "global", alias: gb.alias })).statusCode).toBe(200);
    expect(ga.alias).not.toBe(gb.alias);
  });
});
