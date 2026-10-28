import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanTag, connected, emitAck, makeUser, once, openSocket, startTestServer, type TestUser } from "../test/helpers";

const TAG = "e2er";
let srv: Awaited<ReturnType<typeof startTestServer>>;
const users: TestUser[] = [];
const everyone = { wantGenders: ["male", "female", "non_binary", "prefer_not_to_say"], minAge: 18, maxAge: 99, interests: [] };

beforeAll(async () => {
  await cleanTag(TAG);
  srv = await startTestServer();
});
afterAll(async () => {
  users.forEach((u) => u.socket?.disconnect());
  await cleanTag(TAG);
  await srv.app.close();
});

async function pair(n: string) {
  const mk = async (suffix: string, gender: string) => {
    const u = await makeUser(srv.app, TAG, `${n}${suffix}`, { gender, prefs: { intents: ["polyamory"], ...everyone } });
    users.push(u);
    const s = openSocket(srv.url, u);
    await connected(s);
    return u;
  };
  const a = await mk("a", "female");
  const b = await mk("b", "male");
  const fa = once(a.socket!, "match:found");
  const fb = once(b.socket!, "match:found");
  await emitAck(a.socket!, "match:join");
  await emitAck(b.socket!, "match:join");
  const [ma] = await Promise.all([fa, fb]);
  return { a, b, chatId: ma.chatId as string, you: ma.you };
}

/** A refresh from the server's point of view: the old connection drops, a new one opens a moment later. */
async function refresh(u: TestUser) {
  u.socket!.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  const s = openSocket(srv.url, u);
  const active = once(s, "chat:active", 4000).catch(() => null);
  await connected(s);
  return { socket: s, active: await active };
}

describe("refreshing the page in a 1:1 chat", () => {
  it("keeps the chat: the new connection is told which chat it is in, and gets every message back", async () => {
    const { a, b, chatId } = await pair("keep");
    for (const text of ["hii", "kaise ho", "main theek hu"]) {
      await emitAck(a.socket!, "chat:message", { roomId: chatId, clientMsgId: crypto.randomUUID(), text });
    }
    await emitAck(b.socket!, "chat:message", { roomId: chatId, clientMsgId: crypto.randomUUID(), text: "mast, tum batao" });

    const { socket, active } = await refresh(a);
    expect(active).toMatchObject({ chatId });
    expect(active.you.alias).toBeTruthy();
    expect(active.peer.alias).toBeTruthy();

    const resumed = await emitAck(socket, "chat:resume", { roomId: chatId, lastSeq: 0 });
    expect(resumed.ok).toBe(true);
    expect(resumed.ended).toBe(false);
    expect(resumed.messages.map((m: { text: string }) => m.text)).toEqual(["hii", "kaise ho", "main theek hu", "mast, tum batao"]);
  });

  it("does not tell the other person anything while the refresh happens", async () => {
    const { a, b, chatId } = await pair("quiet");
    let ended = false;
    b.socket!.on("chat:end", () => (ended = true));
    await refresh(a);
    await new Promise((r) => setTimeout(r, 1500));
    expect(ended).toBe(false);
    const stillThere = await emitAck(b.socket!, "chat:message", { roomId: chatId, clientMsgId: crypto.randomUUID(), text: "wapas aaya?" });
    expect(stillThere.ok).toBe(true);
  });

  it("refreshing twice in a row still keeps the chat", async () => {
    const { a, chatId } = await pair("twice");
    await emitAck(a.socket!, "chat:message", { roomId: chatId, clientMsgId: crypto.randomUUID(), text: "pehla" });
    await refresh(a);
    const second = await refresh(a);
    expect(second.active).toMatchObject({ chatId });
    const resumed = await emitAck(second.socket, "chat:resume", { roomId: chatId, lastSeq: 0 });
    expect(resumed.messages.map((m: { text: string }) => m.text)).toEqual(["pehla"]);
  });
});

describe("asking which chat you are in", () => {
  it("answers with the chat after a refresh, so a missed push cannot lose it", async () => {
    const { a, chatId } = await pair("current");
    const { socket } = await refresh(a);
    const r = await emitAck(socket, "chat:current", {});
    expect(r.ok).toBe(true);
    expect(r.chat).toMatchObject({ chatId });
    expect(r.chat.you.alias).toBeTruthy();
    expect(r.chat.peer.alias).toBeTruthy();
    expect(JSON.stringify(r)).not.toMatch(/userId|example\.com|e2er_/);
  });

  it("says there is no chat when there is none, and whether they are waiting", async () => {
    const u = await makeUser(srv.app, TAG, "nochat", { prefs: { intents: ["polyamory"], ...everyone } });
    users.push(u);
    const s = openSocket(srv.url, u);
    await connected(s);
    expect(await emitAck(s, "chat:current", {})).toMatchObject({ ok: true, chat: null, waiting: false });
    await emitAck(s, "match:join");
    expect(await emitAck(s, "chat:current", {})).toMatchObject({ ok: true, chat: null, waiting: true });
    await emitAck(s, "match:leave");
  });
});

/** Waits until the person is in the matching queue, then takes them out so they cannot be paired with the next test's users. */
async function waitQueuedThenLeave(userId: string) {
  for (let i = 0; i < 40 && !(await srv.rt.matching.isWaiting(userId)); i++) await new Promise((r) => setTimeout(r, 100));
  expect(await srv.rt.matching.isWaiting(userId)).toBe(true);
  await srv.rt.matching.leave(userId);
}

describe("closing the page in a 1:1 chat", () => {
  const closeTab = (u: TestUser, hint: boolean) => {
    if (hint) u.socket!.emit("chat:leaving", {});
    return new Promise<void>((r) => setTimeout(() => (u.socket!.disconnect(), r()), 50));
  };

  it("a refresh that says it is leaving still keeps the chat when it comes straight back", async () => {
    const { a, b, chatId } = await pair("hinted");
    let ended = false;
    b.socket!.on("chat:end", () => (ended = true));
    await closeTab(a, true);
    await new Promise((r) => setTimeout(r, 250));
    const s = openSocket(srv.url, a);
    const active = once(s, "chat:active", 4000).catch(() => null);
    await connected(s);
    expect(await active).toMatchObject({ chatId });
    await new Promise((r) => setTimeout(r, 1500)); // well past the short wait
    expect(ended).toBe(false);
  });

  it("closing the tab for good skips the chat: the other person is told and goes straight back to matching", async () => {
    const { a, b, chatId } = await pair("closed");
    const end = once(b.socket!, "chat:end", 6000);
    await closeTab(a, true);
    const e = await end;
    expect(e).toMatchObject({ roomId: chatId, reason: "peer_left" });
    expect(await srv.rt.chats.activeChatId(b.userId)).toBeNull();
    await waitQueuedThenLeave(b.userId); // already looking for the next person
  });

  it("closing the browser without a goodbye is the same, just after the longer wait", async () => {
    const { a, b, chatId } = await pair("silent");
    const end = once(b.socket!, "chat:end", 8000);
    const t0 = Date.now();
    await closeTab(a, false);
    const e = await end;
    expect(e).toMatchObject({ roomId: chatId, reason: "peer_left" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400); // it waited the full grace period first
    await waitQueuedThenLeave(b.userId);
  });

  it("the person who left finds no chat when they come back", { timeout: 15_000 }, async () => {
    const { a, b } = await pair("gone");
    const end = once(b.socket!, "chat:end", 6000);
    await closeTab(a, true);
    await end;
    const s = openSocket(srv.url, a);
    await connected(s);
    expect(await emitAck(s, "chat:current", {})).toMatchObject({ ok: true, chat: null });
    await waitQueuedThenLeave(b.userId);
  });
});
