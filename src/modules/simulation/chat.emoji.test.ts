import { describe, expect, it } from "vitest";
import { emojisIn, mixEmoji } from "./chat.emoji";

/** An rng that returns the given values in turn. */
const seq = (...v: number[]) => { let i = 0; return () => v[Math.min(i++, v.length - 1)]!; };

describe("mixEmoji", () => {
  it("leaves text without emoji alone", () => {
    expect(mixEmoji("kya bol raha h bc")).toBe("kya bol raha h bc");
  });

  it("can move a trailing emoji to the start", () => {
    expect(mixEmoji("kya bol raha h bc 😂", [], seq(0.1))).toBe("😂 kya bol raha h bc");
  });

  it("can put it after the first few words", () => {
    const out = mixEmoji("tu kya bol raha h", [], seq(0.0, 0.0)) ;
    expect(out).toBe("tu kya bol raha h"); // no emoji, untouched
    expect(mixEmoji("tu kya bol raha h 😭", [], seq(0.4, 0.0))).toBe("tu 😭 kya bol raha h");
  });

  it("can double it, and sometimes leaves it at the end", () => {
    expect(mixEmoji("sahi baat 😂", [], seq(0.6, 0.1))).toBe("sahi baat 😂😂");
    expect(mixEmoji("sahi baat 😂", [], seq(0.9))).toBe("sahi baat 😂");
  });

  it("swaps an emoji used a moment ago for a fresh one of the same feeling", () => {
    const out = mixEmoji("sahi baat 😂", ["😂", "😭"], seq(0.0, 0.9));
    expect(emojisIn(out).length).toBeGreaterThan(0);
    for (const e of emojisIn(out)) expect(["😂", "😭"]).not.toContain(e);
    expect(["🤣", "💀", "😆", "😹"]).toContain(emojisIn(out)[0]);
  });

  it("never returns an empty message and keeps the words", () => {
    for (let n = 0; n < 300; n++) {
      const out = mixEmoji("bc yaar mood off h 😭", ["😭", "😂"], () => Math.random());
      expect(out.trim().length).toBeGreaterThan(0);
      for (const w of ["bc", "yaar", "mood", "off", "h"]) expect(out).toContain(w);
    }
  });

  it("an emoji-only reply stays an emoji-only reply", () => {
    for (let n = 0; n < 100; n++) expect(emojisIn(mixEmoji("💀", [], () => Math.random())).length).toBeGreaterThan(0);
    expect(mixEmoji("💀", [], seq(0.5))).toBe("💀");
  });

  it("does not put the emoji in the same place every time", () => {
    const spots = new Set<string>();
    for (let n = 0; n < 200; n++) {
      const out = mixEmoji("tu kya bol raha h 😂", [], () => Math.random());
      spots.add(out.startsWith("😂") ? "start" : out.endsWith("😂😂") || out.endsWith("😂😂😂") ? "doubled" : out.endsWith("😂") ? "end" : "middle");
    }
    expect(spots.size).toBeGreaterThanOrEqual(4);
  });
});
