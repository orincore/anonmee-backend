import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client";
import { groups } from "../db/schema";
import { eq, like } from "drizzle-orm";
import { cleanTag, connected, emitAck, makeUser, once, openSocket, startTestServer, type TestUser } from "../test/helpers";

const TAG = "e2eg";
let srv: Awaited<ReturnType<typeof startTestServer>>;
const all: TestUser[] = [];
const mk = async (n: string, o?: Parameters<typeof makeUser>[3]) => {
  const u = await makeUser(srv.app, TAG, n, o);
  all.push(u);
  return u;
};
const live = async (n: string, o?: Parameters<typeof makeUser>[3]) => {
  const u = await mk(n, o);
  await connected(openSocket(srv.url, u));
  return u;
};
const api = (u: TestUser, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  srv.app.inject({ method: method as "GET", url, payload: payload as object, headers: { cookie: u.cookie, ...headers } });
let keyN = 0;
const create = (u: TestUser, over: Record<string, unknown> = {}, key = `key-${TAG}-${++keyN}-abcdef`) =>
  api(u, "POST", "/groups", { title: "Sunday football talk", topic: "Soccer", description: "Chat about the weekend games", ...over }, { "idempotency-key": key });

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

describe("creating groups", () => {
  it("creates a group, normalises the topic, hides the owner, and announces it live", async () => {
    const owner = await live("own1");
    const watcher = await live("watch1");
    const heard = once(watcher.socket!, "group:created");
    const res = await create(owner);
    expect(res.statusCode).toBe(201);
    const g = res.json().group;
    expect(g.topic).toBe("football");
    expect(g.memberCount).toBe(1);
    expect(JSON.stringify(res.json())).not.toMatch(/ownerId|owner/i);
    expect((await heard).id).toBe(g.id);
  });
  it("is idempotent: retrying with the same key returns the same group", async () => {
    const owner = await mk("idem");
    const a = await create(owner, {}, "same-key-123456");
    const b = await create(owner, {}, "same-key-123456");
    expect(b.json().group.id).toBe(a.json().group.id);
    const rows = await db.select().from(groups).where(eq(groups.ownerId, owner.userId));
    expect(rows).toHaveLength(1);
  });
  it("limits to 3 new groups an hour and requires a request key", async () => {
    const owner = await mk("limit");
    for (let i = 0; i < 3; i++) expect((await create(owner)).statusCode).toBe(201);
    expect((await create(owner)).statusCode).toBe(429);
    expect((await api(owner, "POST", "/groups", { title: "abc", topic: "x" })).statusCode).toBe(400);
  });
  it("needs a login and valid input", async () => {
    expect((await srv.app.inject({ method: "POST", url: "/groups", payload: {} })).statusCode).toBe(401);
    const owner = await mk("val");
    expect((await create(owner, { title: "x" })).statusCode).toBe(400);
  });
});

describe("joining groups", () => {
  it("joining twice returns the same alias and never duplicates the member", async () => {
    const owner = await mk("jo");
    const joiner = await mk("ji");
    const g = (await create(owner)).json().group;
    const first = (await api(joiner, "POST", `/groups/${g.id}/join`)).json();
    const second = (await api(joiner, "POST", `/groups/${g.id}/join`)).json();
    expect(second.alias).toBe(first.alias);
    expect(second.group.memberCount).toBe(2);
  });
  it("there is no cap: forty people can all join at the same moment", async () => {
    const owner = await mk("raceo");
    const g = (await create(owner)).json().group;
    const racers = await Promise.all(Array.from({ length: 40 }, (_, i) => mk(`race${i}`)));
    const results = await Promise.all(racers.map((r) => api(r, "POST", `/groups/${g.id}/join`)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(results.map((r) => r.json().alias)).size).toBe(40);
    expect((await api(owner, "GET", `/groups/${g.id}`)).json().group.memberCount).toBe(41);
    expect(JSON.stringify(results[0]!.json())).not.toMatch(/maxMembers|full/);
  }, 30_000);

  it("a group is not available to someone the owner blocked", async () => {
    const owner = await mk("bo");
    const blocked = await mk("bb");
    const { moderationRepo } = await import("../modules/moderation/moderation.repo");
    await moderationRepo(db).addBlock(owner.userId, blocked.userId);
    const g = (await create(owner)).json().group;
    expect((await api(blocked, "POST", `/groups/${g.id}/join`)).statusCode).toBe(403);
  });
  it("members see only alias, gender and age of each other", async () => {
    const owner = await mk("mo", { gender: "male", dob: "1990-01-01" });
    const g = (await create(owner)).json().group;
    const members = (await api(owner, "GET", `/groups/${g.id}/members`)).json().members;
    expect(Object.keys(members[0]).sort()).toEqual(["age", "alias", "gender"]);
    const outsider = await mk("mx");
    expect((await api(outsider, "GET", `/groups/${g.id}/members`)).statusCode).toBe(403);
  });
  it("an empty group closes and disappears", async () => {
    const owner = await mk("lv");
    const g = (await create(owner)).json().group;
    await api(owner, "POST", `/groups/${g.id}/leave`);
    expect((await api(owner, "GET", `/groups/${g.id}`)).statusCode).toBe(404);
  });
});

describe("discovering groups", () => {
  it("feed puts interest matches first and hides groups you are already in", async () => {
    const owner = await mk("fo");
    const viewer = await mk("fv", { prefs: { intents: ["friendship"], wantGenders: ["male", "female"], minAge: 18, maxAge: 99, interests: ["cricket"] } });
    const cricket = (await create(owner, { title: "Cricket nerds", topic: "cricket" })).json().group;
    const other = (await create(owner, { title: "Cooking tips", topic: "cooking" })).json().group;
    const { redis } = await import("../lib/redis");
    await redis.del("groups:candidates");
    const feed = (await api(viewer, "GET", "/groups/feed")).json().groups;
    expect(Object.keys(feed[0]).sort()).toEqual(["createdAt", "description", "id", "memberCount", "title", "topic"]);
    const ids = feed.map((x: any) => x.id);
    expect(ids.indexOf(cricket.id)).toBeGreaterThan(-1);
    expect(ids.indexOf(cricket.id)).toBeLessThan(ids.indexOf(other.id));
    await api(viewer, "POST", `/groups/${cricket.id}/join`);
    await redis.del("groups:candidates");
    expect((await api(viewer, "GET", "/groups/feed")).json().groups.map((x: any) => x.id)).not.toContain(cricket.id);
  });
  it("browsing pages never repeat or skip, even as new groups arrive", async () => {
    const owner = await mk("pg");
    const { redis } = await import("../lib/redis");
    await db.delete(groups).where(like(groups.title, "Page test %"));
    for (let i = 0; i < 7; i++) {
      await db.insert(groups).values({ ownerId: owner.userId, title: `Page test ${i}`, topic: "pagetopic", tags: ["pagetopic"], description: "", createdAt: new Date(Date.now() - i * 1000) });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r: any = (await api(owner, "GET", `/groups?topic=pagetopic&limit=3${cursor ? `&cursor=${cursor}` : ""}`)).json();
      seen.push(...r.groups.map((x: any) => x.title));
      if (page === 0) await db.insert(groups).values({ ownerId: owner.userId, title: "Page test NEW", topic: "pagetopic", tags: ["pagetopic"], description: "" });
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (let i = 0; i < 7; i++) expect(seen).toContain(`Page test ${i}`);
    await redis.del("groups:candidates");
    await db.delete(groups).where(like(groups.title, "Page test %"));
  });
});

describe("group and global chat", () => {
  it("global chat: join, talk, history for newcomers, dedupe", async () => {
    const a = await live("ga");
    const b = await live("gb");
    const ja = await emitAck(a.socket!, "room:join", { roomId: "global" });
    expect(ja.ok).toBe(true);
    await emitAck(b.socket!, "room:join", { roomId: "global" });
    const heard = once(b.socket!, "room:message");
    const sent = await emitAck(a.socket!, "room:message", { roomId: "global", clientMsgId: "global-msg-0001", text: "hello world" });
    const dup = await emitAck(a.socket!, "room:message", { roomId: "global", clientMsgId: "global-msg-0001", text: "hello world" });
    const m = await heard;
    expect(m.text).toBe("hello world");
    expect(m.alias).toBe(ja.alias);
    expect(Object.keys(m).sort()).toEqual(["age", "alias", "at", "clientMsgId", "gender", "id", "roomId", "seq", "text"]);
    expect(dup.duplicate).toBe(true);
    expect(dup.seq).toBe(sent.seq);
    const late = await live("gc");
    const jl = await emitAck(late.socket!, "room:join", { roomId: "global" });
    expect(jl.messages.some((x: any) => x.text === "hello world")).toBe(true);
    const missed = await emitAck(late.socket!, "room:join", { roomId: "global", lastSeq: sent.seq });
    expect(missed.messages.every((x: any) => x.seq > sent.seq)).toBe(true);
  });
  it("group chat is for members only", async () => {
    const owner = await live("gro");
    const member = await live("grm");
    const outsider = await live("grx");
    const g = (await create(owner)).json().group;
    await api(member, "POST", `/groups/${g.id}/join`);
    expect((await emitAck(outsider.socket!, "room:join", { roomId: g.id })).error).toBe("not_member");
    expect((await emitAck(outsider.socket!, "room:message", { roomId: g.id, clientMsgId: "group-msg-0001", text: "let me in" })).error).toBe("not_member");
    await emitAck(owner.socket!, "room:join", { roomId: g.id });
    await emitAck(member.socket!, "room:join", { roomId: g.id });
    const heard = once(member.socket!, "room:message");
    await emitAck(owner.socket!, "room:message", { roomId: g.id, clientMsgId: "group-msg-0002", text: "welcome" });
    expect((await heard).text).toBe("welcome");
    let leaked = false;
    outsider.socket!.on("room:message", () => (leaked = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(leaked).toBe(false);
  });
  it("a user is throttled in a room, and invalid rooms are refused", async () => {
    const a = await live("gt");
    await emitAck(a.socket!, "room:join", { roomId: "global" });
    const results: any[] = [];
    for (let i = 0; i < 24; i++) {
      results.push(await emitAck(a.socket!, "room:message", { roomId: "global", clientMsgId: `throttle-${String(i).padStart(4, "0")}`, text: "x" }));
      await new Promise((r) => setTimeout(r, 140)); // stay under the socket limiter so the room limiter is what trips
    }
    expect(results.some((r) => r.error === "rate_limited")).toBe(true);
    expect((await emitAck(a.socket!, "room:join", { roomId: "not-a-room" })).error).toBe("not_member");
  });
});
