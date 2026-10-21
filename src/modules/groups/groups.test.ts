import { describe, expect, it } from "vitest";
import { recommendGroups, type GroupCandidate, type Viewer } from "./groups.recommend";

const NOW = 1_700_000_000_000;
const g = (o: Partial<GroupCandidate> & { id: string }): GroupCandidate => ({
  topic: "music", tags: [], memberCount: 10, messagesLast10m: 5,
  createdAt: NOW - 3_600_000, ownerId: "o", ...o,
});
const viewer = (o: Partial<Viewer> = {}): Viewer => ({
  userId: "u", interests: ["football"], joinedGroupIds: new Set(), blockedUserIds: new Set(), ...o,
});

describe("recommendGroups", () => {
  it("ranks interest matches first", () => {
    const out = recommendGroups([g({ id: "a" }), g({ id: "b", topic: "football" })], viewer(), NOW);
    expect(out[0]!.id).toBe("b");
  });
  it("hides joined and blocked-owner groups, but never hides a group for being big", () => {
    const v = viewer({ joinedGroupIds: new Set(["j"]), blockedUserIds: new Set(["bad"]) });
    const out = recommendGroups(
      [g({ id: "huge", memberCount: 50_000 }), g({ id: "j" }), g({ id: "x", ownerId: "bad" }), g({ id: "ok" })],
      v, NOW,
    );
    expect(out.map((x) => x.id).sort()).toEqual(["huge", "ok"]);
  });
  it("keeps results varied across topics", () => {
    const groups = [
      g({ id: "f1", topic: "football", messagesLast10m: 50 }),
      g({ id: "f2", topic: "football", messagesLast10m: 48 }),
      g({ id: "c1", topic: "cricket", tags: ["football"], messagesLast10m: 40 }),
    ];
    expect(recommendGroups(groups, viewer(), NOW).slice(0, 2).map((x) => x.id)).toContain("c1");
  });
  it("works with no interests (cold start) by activity", () => {
    const out = recommendGroups([g({ id: "quiet", messagesLast10m: 0 }), g({ id: "busy", messagesLast10m: 40 })], viewer({ interests: [] }), NOW);
    expect(out[0]!.id).toBe("busy");
  });
});
