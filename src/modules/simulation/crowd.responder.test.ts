import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../contracts";
import { respondAsCrowd } from "./crowd.responder";
import { getAllPersonas } from "./persona.service";
import type { RoomScriptHost } from "./script.runner";
import type { Stance } from "./chat.crowd";
import { generateChatBubbles } from "./together.service";

vi.mock("./together.service", () => ({ generateChatBubbles: vi.fn() }));

const pool = getAllPersonas();
const human = { id: "h1", alias: "Real Human 1", gender: "male", age: 24, text: "aaj date pe gaya tha, bohot awkward tha", at: 0, roomId: "global" } as ChatMessage;

describe("respondAsCrowd", () => {
  let posted: { alias: string; text: string; replyTo?: string }[];
  let history: ChatMessage[];
  let host: RoomScriptHost;
  let audience = true;

  beforeEach(() => {
    vi.useFakeTimers();
    posted = [];
    audience = true;
    history = [{ ...human, at: Date.now() }];
    vi.mocked(generateChatBubbles).mockReset();
    host = {
      roomKey: "global",
      pool: async () => pool,
      history: async () => history,
      isPersonaAlias: (a) => pool.some((p) => p.alias === a),
      hasAudience: async () => audience,
      say: async (persona, text, replyTo) => {
        const m = { id: `m${posted.length}`, alias: persona.alias, gender: persona.gender, age: persona.age, text, at: Date.now() } as ChatMessage;
        posted.push({ alias: persona.alias, text, replyTo });
        history = [...history, m];
        return m;
      },
    };
  });
  afterEach(() => vi.useRealTimers());

  it("several different personas answer in turn, each with its own attitude, and each sees the earlier replies", async () => {
    const stances: (Stance | undefined)[] = [];
    const seen: number[] = [];
    vi.mocked(generateChatBubbles).mockImplementation(async (ctx) => {
      stances.push(ctx.stance);
      seen.push(ctx.messages.length);
      return [`reply ${stances.length}`];
    });
    const run = respondAsCrowd({ host, roomType: "global", message: human, userGender: "male", isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(150_000);
    await run;

    expect(posted.length).toBeGreaterThanOrEqual(3);
    expect(new Set(posted.map((p) => p.alias)).size).toBe(posted.length);
    expect(posted[0]!.replyTo).toBe("h1"); // the first answer quotes the person
    expect(new Set(stances).size).toBeGreaterThan(1); // mixed opinions, not one agreeable tone
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); // later personas see more of the room
    expect(seen[seen.length - 1]).toBeGreaterThan(seen[0]!);
  });

  it("tells every persona what the room is in the middle of, so replies stay on it", async () => {
    const topic = "boss ne aaj sabke saamne mujhe daant diya office me";
    const topics: (string | undefined)[] = [];
    vi.mocked(generateChatBubbles).mockImplementation(async (ctx) => {
      topics.push(ctx.roomTopic);
      return ["haan"];
    });
    const asked = { ...human, text: "kya bola usne?" } as ChatMessage;
    host.topic = () => topic;
    const run = respondAsCrowd({ host, roomType: "global", message: asked, userGender: "male", isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(150_000);
    await run;
    expect(topics.length).toBeGreaterThan(0);
    expect(topics.every((t) => t === topic)).toBe(true);
  });

  it("adds nothing when the held topic is just the message being answered", async () => {
    const seen: (string | undefined)[] = [];
    vi.mocked(generateChatBubbles).mockImplementation(async (ctx) => {
      seen.push(ctx.roomTopic);
      return ["haan"];
    });
    host.topic = () => human.text;
    const run = respondAsCrowd({ host, roomType: "global", message: human, userGender: "male", isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(150_000);
    await run;
    expect(seen.every((t) => t === undefined)).toBe(true);
  });

  it("drops the remaining replies once the person speaks again", async () => {
    let current = true;
    vi.mocked(generateChatBubbles).mockResolvedValue(["haan"]);
    const run = respondAsCrowd({ host, roomType: "global", message: human, isCurrent: () => current });
    await vi.advanceTimersByTimeAsync(22_000); // the first reply lands, the rest are still pending
    current = false;
    const sofar = posted.length;
    await vi.advanceTimersByTimeAsync(150_000);
    await run;
    expect(posted.length).toBe(sofar);
  });

  it("stays quiet where the model has nothing", async () => {
    vi.mocked(generateChatBubbles).mockResolvedValue([]);
    const run = respondAsCrowd({ host, roomType: "global", message: human, isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(150_000);
    await run;
    expect(posted).toEqual([]);
  });
});
