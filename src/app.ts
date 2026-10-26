import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";
import { env } from "./config/env";
import type { Db } from "./db/client";
import { redis } from "./lib/redis";
import { loginThrottle } from "./lib/throttle";
import { groupsRoutes, type GroupView } from "./modules/groups/groups.routes";
import { presenceRoutes } from "./modules/presence/presence.routes";
import type { PulseService } from "./modules/presence/pulse.service";
import { adminRoutes } from "./modules/admin/admin.routes";
import { activityService, type ActivityService } from "./modules/presence/activity.service";
import type { PresenceService } from "./modules/presence/presence.service";
import { analyticsRepo } from "./modules/analytics/analytics.repo";
import { analyticsRoutes } from "./modules/analytics/analytics.routes";
import { moderationRoutes } from "./modules/moderation/moderation.routes";
import type { PeerResolver } from "./modules/moderation/moderation.service";
import { preferencesRoutes } from "./modules/preferences/preferences.routes";
import { authRepo } from "./modules/auth/auth.repo";
import { authRoutes } from "./modules/auth/auth.routes";
import { AuthError, authService } from "./modules/auth/auth.service";
import { verificationService } from "./modules/auth/verification.service";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AppHooks {
  onGroupCreated?: (g: GroupView) => void;
  onGroupLeft?: (groupId: string, userId: string) => void;
  peers?: PeerResolver;
  presence?: PresenceService;
  pulse?: PulseService;
  activity?: ActivityService;
  onUserBanned?: (userId: string) => void;
  onModerated?: (roomId: string, targetUserId: string, kind: "block" | "report", banned: boolean) => void;
}

export async function buildApp(db: Db, hooks: AppHooks = {}) {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : {
      level: "info",
      // Never write credentials or session cookies to logs.
      redact: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"],
    },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 16 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // CSRF defence on top of SameSite=Lax: a browser request that names another origin is refused.
  app.addHook("onRequest", async (req, reply) => {
    if (SAFE.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin && origin !== env.WEB_ORIGIN) {
      return reply.code(403).send({ error: "forbidden", message: "Request blocked." });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid", message: "That request was not valid." });
    if (err instanceof AuthError) return reply.code(err.status).send({ error: err.code, message: err.message, field: err.field });
    if (err.statusCode === 413 || err.statusCode === 415 || err.statusCode === 400) {
      return reply.code(err.statusCode).send({ error: "bad_request", message: "That request was not valid." });
    }
    if (err.statusCode === 429) return reply.code(429).send({ error: "rate_limited", message: "Too many tries. Wait a minute and try again." });
    if (env.NODE_ENV === "test") console.error(err); // tests run with logging off, so surface real failures
    req.log.error(err);
    return reply.code(500).send({ error: "server_error", message: "Something went wrong. Please try again." });
  });

  app.get("/health", async () => ({ ok: true }));
  await app.register(authRoutes(authService(authRepo(db), loginThrottle(redis), verificationService(redis), analyticsRepo(db)), { onAccountDeleted: (id) => hooks.onUserBanned?.(id) }));
  await app.register(analyticsRoutes(db, redis));
  await app.register(preferencesRoutes(db));
  await app.register(groupsRoutes({ db, redis, onCreated: (g) => hooks.onGroupCreated?.(g), onLeft: (gid, uid) => hooks.onGroupLeft?.(gid, uid) }));
  if (hooks.presence && hooks.pulse) {
    const act = hooks.activity ?? activityService(db, redis, hooks.presence);
    await app.register(presenceRoutes(hooks.presence, redis, hooks.pulse, db, act));
    await app.register(adminRoutes({ db, redis, presence: hooks.presence, activity: act, onBanned: (id) => hooks.onUserBanned?.(id) }));
  }
  if (hooks.peers) {
    await app.register(moderationRoutes({ db, peers: hooks.peers, onActed: (...a) => hooks.onModerated?.(...a) }));
  }
  return app;
}
