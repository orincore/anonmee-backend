import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as connect } from "socket.io-client";
import { db } from "../db/client";
import { redis } from "../lib/redis";
import { cleanTag, connected, emitAck, makeUser, once, openSocket, startTestServer, type TestUser } from "../test/helpers";
import { moderationRepo } from "../modules/moderation/moderation.repo";

const TAG = "e2em";
let srv: Awaited<ReturnType<typeof startTestServer>>;
const sockets: TestUser[] = [];
const user = async (n: string, o?: Parameters<typeof makeUser>[3]) => {
  const u = await makeUser(srv.app, TAG, n, o);
  sockets.push(u);
  const s = openSocket(srv.url, u);
  await connected(s);
  return u;
};
const everyone = { wantGenders: ["male", "female", "non_binary", "prefer_not_to_say"], minAge: 18, maxAge: 99, interests: [] };
const prefs = (intents: string[], extra: Record<string, unknown> = {}) => ({ intents, ...everyone, ...extra });

beforeAll(async () => {
  await cleanTag(TAG);
  srv = await startTestServer();
});
afterAll(async () => {
  sockets.forEach((u) => u.socket?.disconnect());
  await cleanTag(TAG);
  await srv.app.close();
});

describe("handshake security", () => {
  it("rejects sockets without a session or from another origin", async () => {
    const anon = connect(srv.url, { transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: { origin: process.env.WEB_ORIGIN! } });
    await expect(connected(anon)).rejects.toThrow("unauthorized");
    const u = await makeUser(srv.app, TAG, "origin");
    const bad = connect(srv.url, { transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: { cookie: u.cookie, origin: "https://evil.example" } });
    await expect(connected(bad)).rejects.toThrow("forbidden");
  });
  it("public namespace gives only the online count", async () => {
    const pub = connect(srv.url + "/public", { transports: ["websocket"], forceNew: true, reconnection: false });
    const msg = await once<{ count: number }>(pub, "presence:count");
    expect(typeof msg.count).toBe("number");
    expect(Object.keys(msg)).toEqual(["count"]);
    pub.disconnect();
  });
  it("rejects malformed events without crashing", async () => {
    const u = await user("junk");
    const res = await emitAck(u.socket!, "chat:message", { roomId: 5 });
    expect(res).toMatchObject({ ok: false, error: "invalid" });
  });
});

describe("1:1 matching", () => {
  it("pairs two compatible people and shares only alias, gender and age", async () => {
    const a = await user("a1", { gender: "female", dob: "1998-06-01", prefs: prefs(["friendship"]) });
    const b = await user("b1", { gender: "male", dob: "1996-03-01", prefs: prefs(["friendship"]) });
    const fa = once(a.socket!, "match:found");
    const fb = once(b.socket!, "match:found");
    await emitAck(a.socket!, "match:join");
    expect((await emitAck(b.socket!, "match:join")).ok).toBe(true);
    const [ma, mb] = await Promise.all([fa, fb]);
    expect(ma.chatId).toBe(mb.chatId);
    expect(ma.peer.alias).toBe(mb.you.alias);
    expect(Object.keys(ma.peer).sort()).toEqual(["age", "alias", "gender"]);
    expect(ma.peer.gender).toBe("male");
    expect(JSON.stringify(ma)).not.toMatch(/example\.com|e2em_|userId/);
    a.socket!.disconnect(); b.socket!.disconnect();
  });

  it("never pairs people whose preferences do not fit", async () => {
    const a = await user("a2", { gender: "male", prefs: prefs(["casual_dating"], { wantGenders: ["female"] }) });
    const b = await user("b2", { gender: "male", prefs: prefs(["casual_dating"], { wantGenders: ["female"] }) });
    let matched = false;
    a.socket!.on("match:found", () => (matched = true));
    b.socket!.on("match:found", () => (matched = true));
    await emitAck(a.socket!, "match:join");
    await emitAck(b.socket!, "match:join");
    await new Promise((r) => setTimeout(r, 2500));
    expect(matched).toBe(false);
    await emitAck(a.socket!, "match:leave");
    await emitAck(b.socket!, "match:leave");
    a.socket!.disconnect(); b.socket!.disconnect();
  });

  it("a block keeps two people apart for good", async () => {
    const a = await user("a3", { prefs: prefs(["casual_chat"]) });
    const b = await user("b3", { prefs: prefs(["casual_chat"]) });
    await moderationRepo(db).addBlock(a.userId, b.userId);
    let matched = false;
    for (const u of [a, b]) u.socket!.on("match:found", () => (matched = true));
    await emitAck(a.socket!, "match:join");
    await emitAck(b.socket!, "match:join");
    await new Promise((r) => setTimeout(r, 2500));
    expect(matched).toBe(false);
    await emitAck(a.socket!, "match:leave");
    await emitAck(b.socket!, "match:leave");
    a.socket!.disconnect(); b.socket!.disconnect();
  });

  it("cannot start matching while already in a chat", async () => {
    const a = await user("a4", { prefs: prefs(["friendship"]) });
    const b = await user("b4", { prefs: prefs(["friendship"]) });
    const f = once(a.socket!, "match:found");
    await emitAck(a.socket!, "match:join");
    await emitAck(b.socket!, "match:join");
    await f;
    expect(await emitAck(a.socket!, "match:join")).toMatchObject({ ok: false, error: "in_chat" });
    a.socket!.disconnect(); b.socket!.disconnect();
  });

  it("20 people joining at once make exactly 10 pairs, nobody twice", async () => {
    const group = await Promise.all(Array.from({ length: 20 }, (_, i) => user(`c${i}`, { prefs: prefs(["open_relationship"]) })));
    const found = new Map<string, string[]>();
    group.forEach((u) => u.socket!.on("match:found", (m: { chatId: string }) => {
      found.set(u.userId, [...(found.get(u.userId) ?? []), m.chatId]);
    }));
    await Promise.all(group.map((u) => emitAck(u.socket!, "match:join")));
    await new Promise((r) => setTimeout(r, 4000));
    expect(found.size).toBe(20);
    for (const ids of found.values()) expect(ids).toHaveLength(1);
    const chats = new Map<string, number>();
    for (const [, ids] of found) chats.set(ids[0]!, (chats.get(ids[0]!) ?? 0) + 1);
    expect(chats.size).toBe(10);
    for (const n of chats.values()) expect(n).toBe(2);
    group.forEach((u) => u.socket!.disconnect());
  }, 30_000);
});

describe("chat", () => {
  async function pair(n: string) {
    const a = await user(`${n}a`, { prefs: prefs(["other"]) });
    const b = await user(`${n}b`, { prefs: prefs(["other"]) });
    const fa = once(a.socket!, "match:found");
    await emitAck(a.socket!, "match:join");
    await emitAck(b.socket!, "match:join");
    const m = await fa;
    return { a, b, chatId: m.chatId as string };
  }

  it("delivers messages in order to both sides and dedupes retries", async () => {
    const { a, b, chatId } = await pair("m1");
    const got: any[] = [];
    b.socket!.on("chat:message", (m) => got.push(m));
    const r1 = await emitAck(a.socket!, "chat:message", { roomId: chatId, clientMsgId: "client-msg-0001", text: "hello there" });
    const dup = await emitAck(a.socket!, "chat:message", { roomId: chatId, clientMsgId: "client-msg-0001", text: "hello there" });
    const r2 = await emitAck(b.socket!, "chat:message", { roomId: chatId, clientMsgId: "client-msg-0002", text: "hi!" });
    await new Promise((r) => setTimeout(r, 300));
    expect(r1.seq).toBe(1);
    expect(dup.duplicate).toBe(true);
    expect(r2.seq).toBe(2);
    expect(got.map((m) => m.text)).toEqual(["hello there", "hi!"]);
    expect(Object.keys(got[0]).sort()).toEqual(["age", "alias", "at", "clientMsgId", "gender", "id", "roomId", "seq", "text"]);
    a.socket!.disconnect(); b.socket!.disconnect();
  });

  it("strangers cannot read or write in someone else's chat", async () => {
    const { a, b, chatId } = await pair("m2");
    const intruder = await user("m2x", { prefs: prefs(["other"]) });
    expect(await emitAck(intruder.socket!, "chat:message", { roomId: chatId, clientMsgId: "client-msg-0009", text: "hey" })).toMatchObject({ ok: false, error: "not_in_chat" });
    expect(await emitAck(intruder.socket!, "chat:resume", { roomId: chatId, lastSeq: 0 })).toMatchObject({ ok: false, error: "not_in_chat" });
    a.socket!.disconnect(); b.socket!.disconnect(); intruder.socket!.disconnect();
  });

  it("a reconnecting user gets exactly the messages they missed", async () => {
    const { a, b, chatId } = await pair("m3");
    await emitAck(a.socket!, "chat:message", { roomId: chatId, clientMsgId: "client-msg-0101", text: "one" });
    await emitAck(a.socket!, "chat:message", { roomId: chatId, clientMsgId: "client-msg-0102", text: "two" });
    b.socket!.disconnect();
    await emitAck(a.socket!, "chat:message", { roomId: chatId, clientMsgId: "client-msg-0103", text: "three" });
    const b2 = openSocket(srv.url, b);
    const active = once(b2, "chat:active");
    await connected(b2);
    expect((await active).chatId).toBe(chatId);
    const res = await emitAck(b2, "chat:resume", { roomId: chatId, lastSeq: 1 });
    expect(res.messages.map((m: any) => m.text)).toEqual(["two", "three"]);
    a.socket!.disconnect(); b2.disconnect();
  });

  it("ending a chat tells the other person and frees both to match again", async () => {
    const { a, b, chatId } = await pair("m4");
    const ended = once(b.socket!, "chat:end");
    await emitAck(a.socket!, "chat:end", { roomId: chatId });
    expect((await ended).roomId).toBe(chatId);
    expect(await emitAck(b.socket!, "chat:message", { roomId: chatId, clientMsgId: "client-msg-0201", text: "still there?" })).toMatchObject({ ok: false, error: "chat_ended" });
    expect(await redis.get(`chat:user:${a.userId}`)).toBeNull();
    a.socket!.disconnect(); b.socket!.disconnect();
  });

  it("flooding gets rate limited, then the socket is cut off", async () => {
    const { a, b, chatId } = await pair("m5");
    const seen: string[] = [];
    let cut = false;
    a.socket!.on("disconnect", () => (cut = true));
    for (let i = 0; i < 40; i++) {
      a.socket!.emit("chat:message", { roomId: chatId, clientMsgId: `client-flood-${String(i).padStart(3, "0")}`, text: "spam" },
        (r: { error?: string }) => seen.push(r.error ?? "ok"));
    }
    await new Promise((r) => setTimeout(r, 1500));
    expect(seen).toContain("rate_limited");
    expect(cut).toBe(true);
    b.socket!.disconnect();
  });
});
