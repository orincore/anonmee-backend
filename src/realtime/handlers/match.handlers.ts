import { z } from "zod";
import { EV, matchJoinSchema } from "../../contracts";
import type { matchingService } from "../../modules/matching/matching.service";
import { MatchError } from "../../modules/matching/matching.service";
import type { MatchSimulator } from "../../modules/simulation";
import type { AppSocket } from "../context";
import { HandlerError, handle } from "../handle";

export function registerMatchHandlers(
  socket: AppSocket,
  matching: ReturnType<typeof matchingService>,
  matchSim?: MatchSimulator
) {
  handle(socket, EV.matchJoin, matchJoinSchema, async (_d, ack) => {
    try {
      await matching.join(socket.data.userId);
      matchSim?.handleUserEnqueued(socket.data.userId);
    } catch (e) {
      if (e instanceof MatchError) throw new HandlerError(e.code, e.message);
      throw e;
    }
    ack({ ok: true });
  });
  handle(socket, EV.matchLeave, z.object({}).passthrough(), async (_d, ack) => {
    matchSim?.cancelWait(socket.data.userId);
    await matching.leave(socket.data.userId);
    ack({ ok: true });
  });
}
