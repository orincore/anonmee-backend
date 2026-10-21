import { describe, expect, it, vi } from "vitest";
import { outcomeForReport } from "./moderation.rules";
import { moderationService, ModerationError } from "./moderation.service";
import type { ModerationRepo } from "./moderation.repo";

describe("outcomeForReport", () => {
  it("bans immediately on an underage report", () => expect(outcomeForReport("underage", 1)).toBe("ban"));
  it("does nothing for a single ordinary report", () => expect(outcomeForReport("spam", 1)).toBe("none"));
  it("queues for review at 3 distinct reporters", () => expect(outcomeForReport("spam", 3)).toBe("review"));
  it("suspends at 5 distinct reporters", () => expect(outcomeForReport("harassment", 5)).toBe("suspend"));
});

const repo = (): ModerationRepo =>
  ({
    addBlock: vi.fn(), removeBlock: vi.fn(), blockedEitherWay: vi.fn(),
    insertReport: vi.fn(), distinctReporters24h: vi.fn().mockResolvedValue(1), setBanned: vi.fn(),
  }) as unknown as ModerationRepo;

describe("moderationService", () => {
  it("report also blocks, so the pair can never be matched again", async () => {
    const r = repo();
    const svc = moderationService(r, { resolve: async () => "bad", recentEvidence: async () => null });
    await svc.report("me", { roomId: "r1", alias: "Quiet Otter 47", reason: "spam", details: "", alsoBlock: true });
    expect(r.addBlock).toHaveBeenCalledWith("me", "bad");
    expect(r.insertReport).toHaveBeenCalledOnce();
  });
  it("bans on underage and never blocks the wrong person", async () => {
    const r = repo();
    const svc = moderationService(r, { resolve: async () => "kid", recentEvidence: async () => null });
    const out = await svc.report("me", { roomId: "r1", alias: "x", reason: "underage", details: "", alsoBlock: true });
    expect(out.outcome).toBe("ban");
    expect(r.setBanned).toHaveBeenCalledWith("kid");
  });
  it("rejects people who are not in the room, and self targets", async () => {
    const gone = moderationService(repo(), { resolve: async () => null, recentEvidence: async () => null });
    await expect(gone.block("me", { roomId: "r", alias: "a" })).rejects.toBeInstanceOf(ModerationError);
    const self = moderationService(repo(), { resolve: async () => "me", recentEvidence: async () => null });
    await expect(self.block("me", { roomId: "r", alias: "a" })).rejects.toMatchObject({ code: "self_target" });
  });
});
