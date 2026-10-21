import { describe, expect, it } from "vitest";
import { pairScore, pickPartner } from "./matching.score";
import type { Ticket } from "./matching.types";

const NOW = 1_700_000_000_000;
const t = (o: Partial<Ticket> & { userId: string }): Ticket => ({
  gender: "female", age: 25, intents: ["friendship"], wantGenders: ["female", "male"],
  minAge: 18, maxAge: 40, interests: [], blocked: new Set(), recentPartners: new Set(),
  enqueuedAt: NOW, ...o,
});

describe("matching", () => {
  it("never pairs a user with themselves", () => {
    const a = t({ userId: "a" });
    expect(pairScore(a, a, NOW)).toBe(-1);
  });
  it("requires mutual gender preference", () => {
    const a = t({ userId: "a", gender: "male", wantGenders: ["female"] });
    const b = t({ userId: "b", gender: "female", wantGenders: ["female"] });
    expect(pairScore(a, b, NOW)).toBe(-1);
  });
  it("requires an intent in common", () => {
    expect(pairScore(t({ userId: "a", intents: ["casual_dating"] }), t({ userId: "b", intents: ["friendship"] }), NOW)).toBe(-1);
  });
  it("respects blocks in either direction", () => {
    const a = t({ userId: "a", blocked: new Set(["b"]) });
    expect(pairScore(a, t({ userId: "b" }), NOW)).toBe(-1);
    expect(pairScore(t({ userId: "b" }), a, NOW)).toBe(-1);
  });
  it("skips recent partners", () => {
    expect(pairScore(t({ userId: "a", recentPartners: new Set(["b"]) }), t({ userId: "b" }), NOW)).toBe(-1);
  });
  it("widens age only after waiting, never gender", () => {
    const old = t({ userId: "b", age: 43 });
    const early = t({ userId: "a", enqueuedAt: NOW });
    expect(pairScore(early, old, NOW)).toBe(-1);
    const waited = t({ userId: "a", enqueuedAt: NOW - 25_000 });
    const olderWaiting = t({ userId: "b", age: 43, minAge: 18, maxAge: 60, enqueuedAt: NOW - 25_000 });
    expect(pairScore(waited, olderWaiting, NOW)).toBeGreaterThan(0);
  });
  it("prefers shared interests and is deterministic", () => {
    const seeker = t({ userId: "s", interests: ["football", "music"] });
    const good = t({ userId: "g", interests: ["football", "music"] });
    const meh = t({ userId: "m", interests: [] });
    expect(pickPartner(seeker, [meh, good], NOW)?.userId).toBe("g");
    expect(pickPartner(seeker, [good, meh], NOW)?.userId).toBe("g");
  });
  it("returns null when nobody is eligible", () => {
    expect(pickPartner(t({ userId: "a" }), [], NOW)).toBeNull();
  });

  it("pairs people only on an exact choice, never just the same family", () => {
    const sexting = t({ userId: "a", intents: ["sexting"] });
    expect(pairScore(sexting, t({ userId: "b", intents: ["long_term"] }), NOW)).toBe(-1);
    expect(pairScore(sexting, t({ userId: "c", intents: ["one_night_stand"] }), NOW)).toBe(-1);
    expect(pairScore(sexting, t({ userId: "d", intents: ["sexting", "flirting"] }), NOW)).toBeGreaterThan(0);
    expect(pairScore(t({ userId: "e", intents: ["friends_with_benefits", "casual_dating"] }), t({ userId: "f", intents: ["casual_dating"] }), NOW)).toBeGreaterThan(0);
  });

  it("friendship seekers are never paired with relationship seekers", () => {
    expect(pairScore(t({ userId: "a", intents: ["friendship"] }), t({ userId: "b", intents: ["long_term", "flirting"] }), NOW)).toBe(-1);
  });

  it("respects trans and non-binary preferences in both directions", () => {
    const seeker = t({ userId: "s", gender: "male", wantGenders: ["trans_woman"] });
    const transWoman = t({ userId: "w", gender: "trans_woman", wantGenders: ["male", "female"] });
    const woman = t({ userId: "x", gender: "female", wantGenders: ["male"] });
    const notIntoMen = t({ userId: "y", gender: "trans_woman", wantGenders: ["female"] });
    expect(pairScore(seeker, transWoman, NOW)).toBeGreaterThan(0);
    expect(pairScore(seeker, woman, NOW)).toBe(-1); // seeker did not ask for women
    expect(pairScore(seeker, notIntoMen, NOW)).toBe(-1); // she did not ask for men
    expect(pairScore(t({ userId: "n", gender: "non_binary", wantGenders: ["trans_man", "non_binary"] }), t({ userId: "m", gender: "trans_man", wantGenders: ["non_binary"] }), NOW)).toBeGreaterThan(0);
  });

  it("open-minded options match on the exact choice: 3-way only with 3-way", () => {
    const three = t({ userId: "a", intents: ["three_way"] });
    expect(pairScore(three, t({ userId: "b", intents: ["two_way"] }), NOW)).toBe(-1);
    expect(pairScore(three, t({ userId: "c", intents: ["four_way", "group_relationship"] }), NOW)).toBe(-1);
    expect(pairScore(three, t({ userId: "d", intents: ["two_way", "three_way"] }), NOW)).toBeGreaterThan(0);
  });

  it("same gender only works between people who really are the same gender", () => {
    const a = t({ userId: "a", gender: "female", intents: ["same_gender"], wantGenders: ["female", "male"] });
    const sameGender = t({ userId: "b", gender: "female", intents: ["same_gender"], wantGenders: ["female", "male"] });
    const otherGender = t({ userId: "c", gender: "male", intents: ["same_gender"], wantGenders: ["female", "male"] });
    expect(pairScore(a, sameGender, NOW)).toBeGreaterThan(0);
    expect(pairScore(a, otherGender, NOW)).toBe(-1); // both ticked it, but they are not the same gender
    // A different shared choice still works across genders.
    const both = t({ userId: "d", gender: "male", intents: ["same_gender", "flirting"], wantGenders: ["female", "male"] });
    expect(pairScore(t({ userId: "e", gender: "female", intents: ["same_gender", "flirting"], wantGenders: ["female", "male"] }), both, NOW)).toBeGreaterThan(0);
  });
});
