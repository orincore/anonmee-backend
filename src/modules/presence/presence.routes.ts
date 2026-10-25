import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RedisClient } from "../../lib/redis";
import type { Db } from "../../db/client";
import { sql } from "drizzle-orm";
import { matches } from "../../db/schema";
import { verifyAccess } from "../../lib/tokens";
import type { ActivityService } from "./activity.service";
import type { PresenceService } from "./presence.service";
import type { PulseService } from "./pulse.service";

/** Public online counter for server-rendered pages. Cached for 5 seconds so it costs almost nothing. */
export function presenceRoutes(presence: PresenceService, redis: RedisClient, pulse: PulseService, db: Db, activity?: ActivityService) {
  return async function (app: FastifyInstance) {
    app.get("/stats/online", async (_req, reply) => {
      const hit = await redis.get("stats:online");
      const count = hit !== null ? Number(hit) : await presence.count();
      if (hit === null) await redis.set("stats:online", count, "EX", 5);
      reply.header("cache-control", "public, max-age=5");
      return { count };
    });

    // What is happening right now. Public, anonymous, cached for 3 seconds.
    app.get("/stats/pulse", async (_req, reply) => {
      const hit = await redis.get("stats:pulse");
      if (hit) {
        reply.header("cache-control", "public, max-age=3");
        return JSON.parse(hit);
      }
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(matches).where(sql`${matches.createdAt} >= date_trunc('day', now())`);
      const out = { online: await presence.count(), chatsToday: row?.n ?? 0, events: await pulse.recent() };
      await redis.set("stats:pulse", JSON.stringify(out), "EX", 3);
      reply.header("cache-control", "public, max-age=3");
      return out;
    });

    // Heartbeat to record screen time (HTTP fallback if socket is reconnecting)
    app.post("/presence/heartbeat", async (req, reply) => {
      const token = req.cookies.access;
      const id = token ? await verifyAccess(token) : null;
      if (!id) return reply.code(401).send({ error: "unauthorized" });
      const b = z.object({ seconds: z.number().int().min(1).max(300) }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: "invalid" });
      if (activity) {
        await activity.recordScreenTime(id, b.data.seconds);
        await presence.touch(id);
      }
      return { ok: true };
    });
  };
}
