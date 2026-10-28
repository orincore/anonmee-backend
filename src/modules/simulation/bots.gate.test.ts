import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKLOG_CAP, BotGate } from "./bots.gate";

/** A tiny stand-in for the socket server: which people are in which socket room. */
function fakeIo(rooms: Record<string, number>) {
  return {
    sockets: { adapter: { rooms: { get: (r: string) => (rooms[r] ? { size: rooms[r] } : undefined) } } },
    in: (r: string) => ({ fetchSockets: async () => Array.from({ length: rooms[r] ?? 0 }) }),
  };
}

describe("BotGate: only spend where it matters", () => {
  let humans: number;
  let rooms: Record<string, number>;
  let gate: BotGate;

  beforeEach(() => {
    vi.useFakeTimers();
    humans = 1;
    rooms = { "r:global": 1 }; // one person connected, not looking at the global chat
    gate = new BotGate(fakeIo(rooms) as never, { realCount: async () => humans } as never);
  });
  afterEach(() => vi.useRealTimers());

  const later = () => vi.advanceTimersByTimeAsync(4000); // past the gate's short cache

  it("writes a small backlog for someone busy elsewhere, then stops", async () => {
    for (let i = 0; i < BACKLOG_CAP; i++) {
      expect(await gate.hasAudience("r:global")).toBe(true);
      gate.notePosted("r:global");
    }
    await later();
    expect(await gate.hasAudience("r:global")).toBe(false); // ten waiting is enough for a "9+" badge
  });

  it("stays stopped, spending nothing, for as long as they do not open the room", async () => {
    for (let i = 0; i < BACKLOG_CAP; i++) gate.notePosted("r:global");
    for (let t = 0; t < 10; t++) {
      await later();
      expect(await gate.hasAudience("r:global")).toBe(false);
    }
  });

  it("starts again the moment someone opens the room, and forgets the backlog", async () => {
    for (let i = 0; i < BACKLOG_CAP; i++) gate.notePosted("r:global");
    await later();
    expect(await gate.hasAudience("r:global")).toBe(false);

    rooms["view:global"] = 1; // they open the global chat
    gate.wake();
    expect(await gate.hasAudience("r:global")).toBe(true);

    delete rooms["view:global"]; // and later leave it again: a fresh backlog, not the old one
    await later();
    expect(await gate.hasAudience("r:global")).toBe(true);
  });

  it("does not count messages written while someone is watching", async () => {
    rooms["view:global"] = 1;
    await gate.hasAudience("r:global");
    for (let i = 0; i < 50; i++) gate.notePosted("r:global");
    delete rooms["view:global"];
    await later();
    expect(await gate.hasAudience("r:global")).toBe(true); // nothing is waiting unread, so the backlog starts at zero
  });

  it("does nothing when nobody is online at all", async () => {
    humans = 0;
    rooms["r:global"] = 0;
    expect(await gate.hasAudience("r:global")).toBe(false);
  });

  it("keeps rooms apart: a watched group does not unlock the global chat", async () => {
    rooms["r:g1"] = 1;
    rooms["view:g1"] = 1;
    for (let i = 0; i < BACKLOG_CAP; i++) gate.notePosted("r:global");
    await later();
    expect(await gate.hasAudience("r:g1")).toBe(true);
    expect(await gate.hasAudience("r:global")).toBe(false);
  });
});
