import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../../config/env";
import type { Db } from "../../db/client";
import { analyticsRepo } from "./analytics.repo";
import { classifyVisit, isBot } from "./attribution";

const body = z.object({
  /** Full landing URL including utm_ parameters, as the browser sees it. */
  url: z.string().url().max(600),
  referrer: z.string().max(600).optional(),
});

/** Do Not Track and Global Privacy Control both mean "do not remember me". */
const optedOut = (h: Record<string, unknown>) => h["dnt"] === "1" || h["sec-gpc"] === "1";

export function analyticsRoutes(db: Db) {
  const repo = analyticsRepo(db);
  return async function (app: FastifyInstance) {
    app.post("/track/visit", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
      if (isBot(req.headers["user-agent"])) return { ok: true };
      const parsed = body.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Bad request." });
      const url = new URL(parsed.data.url);
      // Only count visits to our own site, so the endpoint cannot be used to stuff numbers for other URLs.
      if (url.origin !== env.WEB_ORIGIN) return reply.code(400).send({ error: "invalid", message: "Bad request." });

      const quiet = optedOut(req.headers);
      let visitorId = quiet ? randomUUID() : req.cookies.vid;
      if (!visitorId || !/^[0-9a-f-]{36}$/i.test(visitorId)) visitorId = randomUUID();
      if (!quiet) reply.setCookie("vid", visitorId, { httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production", path: "/", maxAge: 30 * 24 * 3600 });

      const a = classifyVisit(url, parsed.data.referrer, new URL(env.WEB_ORIGIN).hostname);
      const visitId = await repo.recordVisit({ ...a, visitorId, landingPath: url.pathname });
      return { ok: true, visitId };
    });

    // Short links: /c/ab12cd and /r/ab12cd -> the landing page with full utm tags. The visit itself is counted
    // when that page loads, so a click is never counted twice.
    const handleRedirect = async (req: FastifyRequest, reply: FastifyReply) => {
      const { code } = z.object({ code: z.string().regex(/^[a-z0-9]{4,16}$/) }).catch({ code: "" }).parse(req.params);
      const c = code ? await repo.campaignByCode(code) : undefined;
      const target = new URL(c && c.targetPath.startsWith("/") && !c.targetPath.startsWith("//") ? c.targetPath : "/", env.WEB_ORIGIN);
      if (c) {
        target.searchParams.set("utm_source", c.source);
        target.searchParams.set("utm_medium", c.medium);
        target.searchParams.set("utm_campaign", c.campaign);
        if (c.content) target.searchParams.set("utm_content", c.content);
        target.searchParams.set("utm_id", c.code);
      }
      return reply.redirect(target.toString(), 302); // origin is fixed to WEB_ORIGIN: never an open redirect
    };

    app.get("/c/:code", handleRedirect);
    app.get("/r/:code", handleRedirect);
  };
}
export { analyticsRepo };
