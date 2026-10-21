import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { groups } from "../db/schema";
import { redis } from "../lib/redis";
import { cleanTag, connected, emitAck, makeUser, once, openSocket, startTestServer, type TestUser } from "../test/helpers";

const TAG = "e2er";
const THUMB = "\u{1F44D}";
const FIRE = "\u{1F525}";
let srv: Awaited<ReturnType<typeof startTestServer>>;
const all: TestUser[] = [];
const prefs = { intents: ["other"], wantGenders: ["male", "female"], minAge: 18, maxAge: 99, interests: [] };
const live = async (n: string) => {
  const u = await makeUser(srv.app, TAG, n, { prefs });
  all.push(u);
  await connected(openSocket(srv.url, u));
  return u;
};
async function pair(n: string) {
  const a = await live(`${n}a`);
  const b = await live(`${n}b`);
  const fa = once(a.socket!, "match:found");
  await emitAck(a.socket!, "match:join");
  await emitAck(b.socket!, "match:join");
  return { a, b, chatId: (await fa).chatId as string };
}
const say = (u: TestUser, roomId: string, id: string, text: string, replyToId?: string, ev = "chat:message") =>
  emitAck(u.socket!, ev, { roomId, clientMsgId: id, text, ...(replyToId ? { replyToId } : {}) });

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

describe("one-to-one replies and reactions", () => {
  it("a reply carries a server-made quote, and cannot quote what is not there", async () => {
    const { a, b, chatId } = await pair("r1");
    const first = once(b.socket!, "chat:message");
    await say(a, chatId, "orig-msg-0001", "who wants pizza tonight?");
    const orig = await first;
    const got = once(a.socket!, "chat:message");
    await say(b, chatId, "reply-msg-0001", "me!", orig.id);
    const reply = await got;
    expect(reply.replyTo).toEqual({ id: orig.id, alias: orig.alias, text: "who wants pizza tonight?" });
    expect((await say(b, chatId, "reply-msg-0002", "x", "00000000-0000-4000-8000-000000000000")).error).toBe("bad_reply");
    expect((await emitAck(b.socket!, "chat:message", { roomId: chatId, clientMsgId: "reply-msg-0003", text: "x", replyToId: "not-a-uuid" })).error).toBe("invalid");
  });

  it("long quotes are shortened by the server", async () => {
    const { a, b, chatId } = await pair("r2");
    const first = once(b.socket!, "chat:message");
    await say(a, chatId, "orig-msg-0002", "word ".repeat(100));
    const orig = await first;
    const got = once(a.socket!, "chat:message");
    await say(b, chatId, "reply-msg-0004", "long one", orig.id);
    expect((await got).replyTo.text.length).toBeLessThanOrEqual(123);
  });

  it("reactions toggle, count each person once, and tell both sides only the counts", async () => {
    const { a, b, chatId } = await pair("r3");
    const first = once(b.socket!, "chat:message");
    await say(a, chatId, "orig-msg-0003", "good news");
    const m = await first;

    let upd = once(a.socket!, "chat:reactions");
    expect(await emitAck(b.socket!, "chat:react", { roomId: chatId, messageId: m.id, emoji: THUMB })).toMatchObject({ ok: true, mine: true });
    const e1 = await upd;
    expect(e1).toEqual({ roomId: chatId, messageId: m.id, reactions: { [THUMB]: 1 } });

    upd = once(b.socket!, "chat:reactions");
    await emitAck(a.socket!, "chat:react", { roomId: chatId, messageId: m.id, emoji: THUMB });
    expect((await upd).reactions[THUMB]).toBe(2);

    upd = once(a.socket!, "chat:reactions");
    expect(await emitAck(b.socket!, "chat:react", { roomId: chatId, messageId: m.id, emoji: THUMB })).toMatchObject({ ok: true, mine: false });
    expect((await upd).reactions).toEqual({ [THUMB]: 1 });
    expect(JSON.stringify(e1)).not.toMatch(/alias|userId/);
  });

  it("rejects emoji outside the allowed set, unknown messages, strangers, and ended chats", async () => {
    const { a, b, chatId } = await pair("r4");
    const first = once(b.socket!, "chat:message");
    await say(a, chatId, "orig-msg-0004", "hi");
    const m = await first;
    expect((await emitAck(b.socket!, "chat:react", { roomId: chatId, messageId: m.id, emoji: "\u{1F4A9}" })).error).toBe("invalid");
    expect((await emitAck(b.socket!, "chat:react", { roomId: chatId, messageId: "00000000-0000-4000-8000-000000000000", emoji: FIRE })).error).toBe("bad_message");
    const stranger = await live("r4x");
    expect((await emitAck(stranger.socket!, "chat:react", { roomId: chatId, messageId: m.id, emoji: FIRE })).error).toBe("not_in_chat");
    await emitAck(a.socket!, "chat:end", { roomId: chatId });
    expect((await emitAck(b.socket!, "chat:react", { roomId: chatId, messageId: m.id, emoji: FIRE })).error).toBe("chat_ended");
  });

  it("reconnecting shows each person their own reactions", async () => {
    const { a, b, chatId } = await pair("r5");
    const first = once(b.socket!, "chat:message");
    await say(a, chatId, "orig-msg-0005", "react to me");
    const m = await first;
    await emitAck(b.socket!, "chat:react", { roomId: chatId, messageId: m.id, emoji: FIRE });
    const forB = (await emitAck(b.socket!, "chat:resume", { roomId: chatId, lastSeq: 0 })).messages[0];
    const forA = (await emitAck(a.socket!, "chat:resume", { roomId: chatId, lastSeq: 0 })).messages[0];
    expect(forB).toMatchObject({ reactions: { [FIRE]: 1 }, mine: [FIRE] });
    expect(forA).toMatchObject({ reactions: { [FIRE]: 1 }, mine: [] });
  });
});

describe("group and global replies and reactions", () => {
  async function room(n: string) {
    const owner = await live(`${n}o`);
    const gid = (await srv.app.inject({ method: "POST", url: "/groups", payload: { title: "Reply test", topic: "replies", description: "" }, headers: { cookie: owner.cookie, "idempotency-key": `react-grp-key-${n}` } })).json().group.id;
    const member = await live(`${n}m`);
    await srv.app.inject({ method: "POST", url: `/groups/${gid}/join`, headers: { cookie: member.cookie } });
    await emitAck(owner.socket!, "room:join", { roomId: gid });
    await emitAck(member.socket!, "room:join", { roomId: gid });
    return { owner, member, gid };
  }

  it("replies quote the real message, from the recent window and from the database", async () => {
    const { owner, member, gid } = await room("g1");
    const heard = once(member.socket!, "room:message");
    await say(owner, gid, "group-orig-0001", "the original take", undefined, "room:message");
    const orig = await heard;
    const got = once(owner.socket!, "room:message");
    await say(member, gid, "group-reply-0001", "disagree", orig.id, "room:message");
    expect((await got).replyTo).toMatchObject({ id: orig.id, text: "the original take" });

    await new Promise((r) => setTimeout(r, 700)); // let the batch writer save it
    await redis.del(`room:${gid}:recent`);
    const cold = once(owner.socket!, "room:message");
    await say(member, gid, "group-reply-0002", "still disagree", orig.id, "room:message");
    expect((await cold).replyTo.text).toBe("the original take");
    expect((await say(member, gid, "group-reply-0003", "x", "00000000-0000-4000-8000-000000000000", "room:message")).error).toBe("bad_reply");
  });

  it("reactions work for members, are counts only, and show up in history", async () => {
    const { owner, member, gid } = await room("g2");
    const heard = once(member.socket!, "room:message");
    await say(owner, gid, "group-orig-0002", "react here", undefined, "room:message");
    const m = await heard;
    const upd = once(owner.socket!, "room:reactions");
    expect(await emitAck(member.socket!, "room:react", { roomId: gid, messageId: m.id, emoji: FIRE })).toMatchObject({ ok: true, mine: true });
    expect(await upd).toEqual({ roomId: gid, messageId: m.id, reactions: { [FIRE]: 1 } });

    const stranger = await live("g1x");
    expect((await emitAck(stranger.socket!, "room:react", { roomId: gid, messageId: m.id, emoji: FIRE })).error).toBe("not_member");

    const hist = await emitAck(member.socket!, "room:join", { roomId: gid });
    expect(hist.messages.find((x: { id: string }) => x.id === m.id)).toMatchObject({ reactions: { [FIRE]: 1 }, mine: [FIRE] });
    const histOwner = await emitAck(owner.socket!, "room:join", { roomId: gid });
    expect(histOwner.messages.find((x: { id: string }) => x.id === m.id)).toMatchObject({ reactions: { [FIRE]: 1 }, mine: [] });
  });

  it("the global room supports both too", async () => {
    const a = await live("gl1");
    const b = await live("gl2");
    await emitAck(a.socket!, "room:join", { roomId: "global" });
    await emitAck(b.socket!, "room:join", { roomId: "global" });
    const heard = once(b.socket!, "room:message");
    await say(a, "global", "global-orig-0001", "hello world", undefined, "room:message");
    const m = await heard;
    const got = once(a.socket!, "room:message");
    await say(b, "global", "global-reply-0001", "hello back", m.id, "room:message");
    expect((await got).replyTo.text).toBe("hello world");
    expect((await emitAck(b.socket!, "room:react", { roomId: "global", messageId: m.id, emoji: THUMB })).ok).toBe(true);
  });
});
