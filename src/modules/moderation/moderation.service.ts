import type { BlockInput, ReportInput } from "../../contracts";
import { outcomeForReport } from "./moderation.rules";
import type { ModerationRepo } from "./moderation.repo";

/** Resolves a room + alias to the account behind it. Provided by chat/groups, so this module never learns identities itself. */
export interface PeerResolver {
  resolve(roomId: string, alias: string, requesterId: string): Promise<string | null>;
  /** Last few messages from the reported person, for the review queue only. */
  recentEvidence(roomId: string, reportedId: string): Promise<string | null>;
}

export class ModerationError extends Error {
  constructor(readonly code: "not_in_room" | "self_target", message: string) {
    super(message);
  }
}

export function moderationService(repo: ModerationRepo, peers: PeerResolver) {
  async function target(requesterId: string, roomId: string, alias: string) {
    const reportedId = await peers.resolve(roomId, alias, requesterId);
    if (!reportedId) throw new ModerationError("not_in_room", "That person is no longer in this chat.");
    if (reportedId === requesterId) throw new ModerationError("self_target", "You cannot do that to yourself.");
    return reportedId;
  }

  return {
    /** Blocks are permanent and two-way for matching: neither side is ever paired or shown the other again. */
    async block(requesterId: string, input: BlockInput) {
      const blockedId = await target(requesterId, input.roomId, input.alias);
      await repo.addBlock(requesterId, blockedId);
      return { blockedId }; // internal only: callers use it to end the chat, never send it to a client
    },

    async report(requesterId: string, input: ReportInput) {
      const reportedId = await target(requesterId, input.roomId, input.alias);
      const evidence = await peers.recentEvidence(input.roomId, reportedId);
      await repo.insertReport({
        reporterId: requesterId,
        reportedId,
        roomId: input.roomId,
        reason: input.details ? `${input.reason}: ${input.details}` : input.reason,
        evidence,
      });
      // Reporting always blocks too, so the two are never put together again.
      await repo.addBlock(requesterId, reportedId);

      const outcome = outcomeForReport(input.reason, await repo.distinctReporters24h(reportedId));
      if (outcome === "ban") await repo.setBanned(reportedId);
      return { reportedId, outcome };
    },
  };
}
