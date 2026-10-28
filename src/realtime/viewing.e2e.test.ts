import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanTag, connected, emitAck, makeUser, openSocket, startTestServer, type TestUser } from "../test/helpers";

const TAG = "e2ev";
let srv: Awaited<ReturnType<typeof startTestServer>>;
const users: TestUser[] = [];

beforeAll(async () => {
  await cleanTag(TAG);
  srv = await startTestServer();
});
afterAll(async () => {
  users.forEach((u) => u.socket?.disconnect());
  await cleanTag(TAG);
  await srv.app.close();
});

const count = async (room: string) => (await srv.rt.io.in(room).fetchSockets()).length;

describe("who is looking at the global chat", () => {
  it("being connected is not the same as looking: only opening the room counts, and closing it stops", async () => {
    const u = await makeUser(srv.app, TAG, "viewer");
    users.push(u);
    const s = openSocket(srv.url, u);
    await connected(s);
    await new Promise((r) => setTimeout(r, 400));
    // Other test files share this Redis and have their own sockets, so everything is counted against a baseline.
    const looking0 = await count("view:global");
    const joined0 = await count("r:global");

    expect(joined0).toBeGreaterThanOrEqual(1); // connected people are in the room for unread counts
    expect((await emitAck(s, "room:join", { roomId: "global" })).ok).toBe(true);
    expect(await count("view:global")).toBe(looking0 + 1); // only opening the room counts as looking

    expect((await emitAck(s, "room:leave", { roomId: "global" })).ok).toBe(true);
    expect(await count("view:global")).toBe(looking0);
    expect(await count("r:global")).toBe(joined0); // still joined, so unread counts keep working
  });

  it("closing the tab while looking stops it too", async () => {
    const u = await makeUser(srv.app, TAG, "closer");
    users.push(u);
    const s = openSocket(srv.url, u);
    await connected(s);
    const before = await count("view:global");
    await emitAck(s, "room:join", { roomId: "global" });
    expect(await count("view:global")).toBe(before + 1);
    s.disconnect();
    await new Promise((r) => setTimeout(r, 400));
    expect(await count("view:global")).toBe(before);
  });

  it("two people can look at once, and one leaving does not hide the room from the other", async () => {
    const a = await makeUser(srv.app, TAG, "twoa");
    const b = await makeUser(srv.app, TAG, "twob");
    users.push(a, b);
    const sa = openSocket(srv.url, a);
    const sb = openSocket(srv.url, b);
    await Promise.all([connected(sa), connected(sb)]);
    const before = await count("view:global");
    await emitAck(sa, "room:join", { roomId: "global" });
    await emitAck(sb, "room:join", { roomId: "global" });
    expect(await count("view:global")).toBe(before + 2);
    await emitAck(sa, "room:leave", { roomId: "global" });
    expect(await count("view:global")).toBe(before + 1); // one leaving does not hide the room from the other
  });
});
