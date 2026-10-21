import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { blockSchema, reportSchema } from "../../contracts";
import type { Db } from "../../db/client";
import { blocks } from "../../db/schema";
import { requireUser } from "../auth/auth.routes";
import { moderationRepo } from "./moderation.repo";
import { ModerationError, moderationService, type PeerResolver } from "./moderation.service";

export function moderationRoutes(deps: {
  db: Db;
  peers: PeerResolver;
  /** Ends a 1:1 chat and removes banned users from live rooms. Provided by the realtime layer. */
  onActed: (roomId: string, targetUserId: string, kind: "block" | "report", banned: boolean) => void;
}) {
  const repo = moderationRepo(deps.db);
  const svc = moderationService(repo, deps.peers);

  return async function (app: FastifyInstance) {
    const limited = { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } };
    const fail = (e: unknown, reply: import("fastify").FastifyReply) => {
      if (e instanceof ModerationError) return reply.code(e.code === "self_target" ? 400 : 404).send({ error: e.code, message: e.message });
      throw e;
    };

    app.post("/moderation/report", limited, async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      const parsed = reportSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Pick a reason." });
      try {
        const out = await svc.report(uid, parsed.data);
        await deps.db.update(blocks).set({ alias: parsed.data.alias }).where(and(eq(blocks.blockerId, uid), eq(blocks.blockedId, out.reportedId)));
        deps.onActed(parsed.data.roomId, out.reportedId, "report", out.outcome === "ban");
        return { ok: true }; // never says who was reported or what happened to them
      } catch (e) { return fail(e, reply); }
    });

    app.post("/moderation/block", limited, async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      const parsed = blockSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "That request was not valid." });
      try {
        const { blockedId } = await svc.block(uid, parsed.data);
        await deps.db.update(blocks).set({ alias: parsed.data.alias }).where(and(eq(blocks.blockerId, uid), eq(blocks.blockedId, blockedId)));
        deps.onActed(parsed.data.roomId, blockedId, "block", false);
        return { ok: true };
      } catch (e) { return fail(e, reply); }
    });

    app.get("/moderation/blocks", async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      const rows = await deps.db.select({ id: blocks.id, alias: blocks.alias, at: blocks.createdAt }).from(blocks).where(eq(blocks.blockerId, uid)).orderBy(desc(blocks.createdAt)).limit(200);
      return { blocks: rows.map((r) => ({ id: r.id, alias: r.alias ?? "Someone", at: r.at.getTime() })) };
    });

    app.delete("/moderation/blocks/:id", async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!p.success) return reply.code(404).send({ error: "not_found", message: "Not found." });
      await deps.db.delete(blocks).where(and(eq(blocks.id, p.data.id), eq(blocks.blockerId, uid)));
      return { ok: true };
    });
  };
}
