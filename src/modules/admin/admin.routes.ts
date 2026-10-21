import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, gte, ilike, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env";
import { ageFromDob } from "../../contracts";
import type { Db } from "../../db/client";
import {
  adminAudit, blocks, campaigns, groups, matches, preferences, refreshTokens, reports, roomMessages, users, visits,
} from "../../db/schema";
import type { RedisClient } from "../../lib/redis";
import { loginThrottle } from "../../lib/throttle";
import { buildCampaignUrl } from "../analytics/attribution";
import type { PresenceService } from "../presence/presence.service";
import { ADMIN_TTL_S, AdminAuthError, adminAuth, requireRole, type AdminSession } from "./admin.auth";

const ALL = ["owner", "moderator", "analyst"] as const;
const STAFF = ["owner", "moderator"] as const;
const OWNER = ["owner"] as const;

const pageQ = z.object({ cursor: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
const enc = (at: Date, id: string) => Buffer.from(`${at.getTime()}:${id}`).toString("base64url");
function dec(c?: string) {
  if (!c) return undefined;
  const [ms, id] = Buffer.from(c, "base64url").toString().split(":");
  const at = new Date(Number(ms));
  return Number.isNaN(at.getTime()) || !id ? undefined : { at, id };
}
const daysQ = z.object({ days: z.coerce.number().int().min(1).max(365).default(7) });
const since = (days: number) => new Date(Date.now() - days * 86_400_000);

export function adminRoutes(deps: { db: Db; redis: RedisClient; presence: PresenceService; onBanned: (userId: string) => void }) {
  const { db, redis } = deps;
  const auth = adminAuth(db, redis, loginThrottle(redis));
  const audit = (s: AdminSession, action: string, targetUserId?: string, meta?: unknown) =>
    db.insert(adminAudit).values({ adminId: s.adminId, action, targetUserId, meta: meta ? JSON.stringify(meta) : null });

  return async function (app: FastifyInstance) {
    // Admin cookies are never sent to other pages or sites.
    const cookie = { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "strict" as const, path: "/admin" };

    app.post("/admin/auth/login", { config: { rateLimit: { max: env.NODE_ENV === "test" ? 1000 : 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      const p = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128), code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "invalid", message: "Enter your email, password and 6 digit code." });
      try {
        const { token, admin } = await auth.login(p.data.email, p.data.password, p.data.code, req.ip);
        reply.setCookie("admin_session", token, { ...cookie, maxAge: ADMIN_TTL_S });
        return { admin };
      } catch (e) {
        if (e instanceof AdminAuthError) return reply.code(e.status).send({ error: "denied", message: e.message });
        throw e;
      }
    });

    app.post("/admin/auth/logout", async (_req, reply) => {
      reply.clearCookie("admin_session", { path: "/admin" });
      return { ok: true };
    });

    app.get("/admin/me", async (req, reply) => {
      const s = await requireRole(auth, req, reply, [...ALL]);
      return s ? { admin: { email: s.email, role: s.role } } : undefined;
    });

    // ---------- Overview ----------
    app.get("/admin/overview", async (req, reply) => {
      const s = await requireRole(auth, req, reply, [...ALL]);
      if (!s) return;
      const { days } = daysQ.parse(req.query);
      const cacheKey = `admin:overview:${days}`;
      const hit = await redis.get(cacheKey);
      if (hit) return JSON.parse(hit);

      const from = since(days);
      const prev = since(days * 2);
      const n = (q: Promise<{ n: number }[]>) => q.then((r) => r[0]?.n ?? 0);
      const [totalUsers, newNow, newPrev, banned, matchRows, groupsMade, messages, openReports, daily] = await Promise.all([
        n(db.select({ n: sql<number>`count(*)::int` }).from(users)),
        n(db.select({ n: sql<number>`count(*)::int` }).from(users).where(gte(users.createdAt, from))),
        n(db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(gte(users.createdAt, prev), lt(users.createdAt, from)))),
        n(db.select({ n: sql<number>`count(*)::int` }).from(users).where(sql`${users.bannedAt} is not null`)),
        db.select({
          total: sql<number>`count(*)::int`,
          avgWait: sql<number>`coalesce(avg(${matches.waitMs}), 0)::int`,
          lasted: sql<number>`count(*) filter (where ${matches.endedAt} is not null and ${matches.endedAt} - ${matches.createdAt} > interval '60 seconds')::int`,
          ended: sql<number>`count(*) filter (where ${matches.endedAt} is not null)::int`,
        }).from(matches).where(gte(matches.createdAt, from)),
        n(db.select({ n: sql<number>`count(*)::int` }).from(groups).where(gte(groups.createdAt, from))),
        n(db.select({ n: sql<number>`count(*)::int` }).from(roomMessages).where(gte(roomMessages.createdAt, from))),
        n(db.select({ n: sql<number>`count(*)::int` }).from(reports).where(eq(reports.status, "open"))),
        db.execute(sql`select to_char(d, 'YYYY-MM-DD') as day,
            (select count(*)::int from users where created_at >= d and created_at < d + interval '1 day') as users,
            (select count(*)::int from matches where created_at >= d and created_at < d + interval '1 day') as matches
          from generate_series(date_trunc('day', ${from.toISOString()}::timestamp), date_trunc('day', now()), interval '1 day') d order by d`),
      ]);
      const m = matchRows[0]!;
      const out = {
        days, totalUsers, newUsers: newNow, newUsersPrevious: newPrev, bannedUsers: banned, onlineNow: await deps.presence.count(),
        matches: m.total, averageWaitMs: m.avgWait, matchSuccessRate: m.ended ? Math.round((m.lasted / m.ended) * 100) : null,
        groupsCreated: groupsMade, messagesSent: messages, openReports, daily,
      };
      await redis.set(cacheKey, JSON.stringify(out), "EX", 60);
      return out;
    });

    // ---------- Escalations ----------
    app.get("/admin/escalations", async (req, reply) => {
      const s = await requireRole(auth, req, reply, [...STAFF]);
      if (!s) return;
      const q = pageQ.extend({ status: z.enum(["open", "reviewed", "actioned", "dismissed"]).default("open") }).parse(req.query);
      const c = dec(q.cursor);
      const where = and(
        eq(reports.status, q.status),
        c ? or(gt(reports.createdAt, c.at), and(eq(reports.createdAt, c.at), gt(reports.id, c.id))) : undefined,
      );
      const rows = await db.select({
        id: reports.id, reason: reports.reason, evidence: reports.evidence, status: reports.status, roomId: reports.roomId, createdAt: reports.createdAt,
        reportedId: reports.reportedId, username: users.username, gender: users.gender, dob: users.dateOfBirth, bannedAt: users.bannedAt,
        reporters: sql<number>`(select count(distinct r2.reporter_id)::int from reports r2 where r2.reported_id = ${reports.reportedId})`,
      }).from(reports).innerJoin(users, eq(users.id, reports.reportedId))
        .where(where).orderBy(asc(reports.createdAt), asc(reports.id)).limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return {
        escalations: page.map((r) => ({
          id: r.id, reason: r.reason, evidence: r.evidence, status: r.status, createdAt: r.createdAt.getTime(), roomId: r.roomId,
          reported: { id: r.reportedId, username: r.username, gender: r.gender, age: ageFromDob(r.dob), banned: !!r.bannedAt, distinctReporters: r.reporters },
        })),
        nextCursor: rows.length > q.limit ? enc(page[page.length - 1]!.createdAt, page[page.length - 1]!.id) : null,
      };
    });

    app.post("/admin/escalations/:id/action", async (req, reply) => {
      const s = await requireRole(auth, req, reply, [...STAFF]);
      if (!s) return;
      const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const b = z.object({ action: z.enum(["dismiss", "warn", "suspend", "ban", "unban"]) }).safeParse(req.body);
      if (!p.success || !b.success) return reply.code(400).send({ error: "invalid", message: "Bad request." });
      const [r] = await db.select().from(reports).where(eq(reports.id, p.data.id)).limit(1);
      if (!r) return reply.code(404).send({ error: "not_found", message: "Report not found." });
      const act = b.data.action;
      if (act === "suspend" || act === "ban") {
        await db.update(users).set({ bannedAt: new Date() }).where(eq(users.id, r.reportedId));
        await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, r.reportedId), isNull(refreshTokens.revokedAt)));
        deps.onBanned(r.reportedId);
      }
      if (act === "unban") await db.update(users).set({ bannedAt: null }).where(eq(users.id, r.reportedId));
      await db.update(reports).set({ status: act === "dismiss" ? "dismissed" : "actioned", evidence: act === "dismiss" ? null : r.evidence }).where(eq(reports.id, r.id));
      await audit(s, `report.${act}`, r.reportedId, { reportId: r.id });
      return { ok: true };
    });

    // ---------- Users ----------
    app.get("/admin/users", async (req, reply) => {
      const s = await requireRole(auth, req, reply, [...STAFF]);
      if (!s) return;
      const q = pageQ.extend({
        q: z.string().trim().max(60).optional(), status: z.enum(["active", "banned"]).optional(),
        channel: z.enum(["seo", "llm", "utm", "social", "referral", "direct"]).optional(),
      }).parse(req.query);
      const c = dec(q.cursor);
      const term = q.q ? `${q.q.replace(/[%_\\]/g, "\\$&")}%` : undefined; // prefix search can use the unique indexes
      const where = and(
        term ? or(ilike(users.email, term), ilike(users.username, term)) : undefined,
        q.status === "banned" ? sql`${users.bannedAt} is not null` : q.status === "active" ? isNull(users.bannedAt) : undefined,
        q.channel ? eq(users.acquisitionChannel, q.channel) : undefined,
        c ? or(lt(users.createdAt, c.at), and(eq(users.createdAt, c.at), lt(users.id, c.id))) : undefined,
      );
      const rows = await db.select({
        id: users.id, email: users.email, username: users.username, gender: users.gender, dob: users.dateOfBirth,
        createdAt: users.createdAt, lastSeenAt: users.lastSeenAt, bannedAt: users.bannedAt, channel: users.acquisitionChannel,
      }).from(users).where(where).orderBy(desc(users.createdAt), desc(users.id)).limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return {
        users: page.map((u) => ({ id: u.id, email: u.email, username: u.username, gender: u.gender, age: ageFromDob(u.dob), createdAt: u.createdAt.getTime(), lastSeenAt: u.lastSeenAt?.getTime() ?? null, banned: !!u.bannedAt, channel: u.channel })),
        nextCursor: rows.length > q.limit ? enc(page[page.length - 1]!.createdAt, page[page.length - 1]!.id) : null,
      };
    });

    app.get("/admin/users/:id", async (req, reply) => {
      const s = await requireRole(auth, req, reply, [...STAFF]);
      if (!s) return;
      const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!p.success) return reply.code(404).send({ error: "not_found", message: "No such user." });
      const [u] = await db.select().from(users).where(eq(users.id, p.data.id)).limit(1);
      if (!u) return reply.code(404).send({ error: "not_found", message: "No such user." });
      await audit(s, "user.view", u.id); // every look at an account is on record
      const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
      const [prefs] = await db.select().from(preferences).where(eq(preferences.userId, u.id)).limit(1);
      const [matchesN, blocksGiven, blocksReceived, reportsMade, reportsReceived, groupsOwned, sessions] = await Promise.all([
        one(db.select({ n: sql<number>`count(*)::int` }).from(matches).where(or(eq(matches.userAId, u.id), eq(matches.userBId, u.id)))),
        one(db.select({ n: sql<number>`count(*)::int` }).from(blocks).where(eq(blocks.blockerId, u.id))),
        one(db.select({ n: sql<number>`count(*)::int` }).from(blocks).where(eq(blocks.blockedId, u.id))),
        one(db.select({ n: sql<number>`count(*)::int` }).from(reports).where(eq(reports.reporterId, u.id))),
        one(db.select({ n: sql<number>`count(*)::int` }).from(reports).where(eq(reports.reportedId, u.id))),
        one(db.select({ n: sql<number>`count(*)::int` }).from(groups).where(eq(groups.ownerId, u.id))),
        one(db.select({ n: sql<number>`count(*)::int` }).from(refreshTokens).where(and(eq(refreshTokens.userId, u.id), isNull(refreshTokens.revokedAt)))),
      ]);
      return {
        user: {
          id: u.id, email: u.email, username: u.username, gender: u.gender, dateOfBirth: u.dateOfBirth.toISOString().slice(0, 10), age: ageFromDob(u.dateOfBirth),
          createdAt: u.createdAt.getTime(), lastSeenAt: u.lastSeenAt?.getTime() ?? null, emailVerified: !!u.emailVerifiedAt, bannedAt: u.bannedAt?.getTime() ?? null,
          acquisition: { channel: u.acquisitionChannel, source: u.acquisitionSource, campaign: u.acquisitionCampaign },
          preferences: prefs ? { intents: prefs.intents, wantGenders: prefs.wantGenders, minAge: prefs.minAge, maxAge: prefs.maxAge, interests: prefs.interests } : null,
          counts: { matches: matchesN, blocksGiven, blocksReceived, reportsMade, reportsReceived, groupsOwned, activeSessions: sessions },
        },
      };
    });

    app.post("/admin/users/:id/status", async (req, reply) => {
      const s = await requireRole(auth, req, reply, [...STAFF]);
      if (!s) return;
      const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const b = z.object({ banned: z.boolean() }).safeParse(req.body);
      if (!p.success || !b.success) return reply.code(400).send({ error: "invalid", message: "Bad request." });
      await db.update(users).set({ bannedAt: b.data.banned ? new Date() : null }).where(eq(users.id, p.data.id));
      if (b.data.banned) {
        await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, p.data.id), isNull(refreshTokens.revokedAt)));
        deps.onBanned(p.data.id);
      }
      await audit(s, b.data.banned ? "user.ban" : "user.unban", p.data.id);
      return { ok: true };
    });

    // ---------- Traffic analytics ----------
    app.get("/admin/analytics", async (req, reply) => {
      const s = await requireRole(auth, req, reply, [...ALL]);
      if (!s) return;
      const { days } = daysQ.parse(req.query);
      const cacheKey = `admin:analytics:${days}`;
      const hit = await redis.get(cacheKey);
      if (hit) return JSON.parse(hit);
      const from = since(days);
      const [byChannel, signupsByChannel, topSources, topCampaigns, seoDaily, seoPages, llmSources] = await Promise.all([
        db.select({ channel: visits.channel, visits: sql<number>`count(*)::int`, visitors: sql<number>`count(distinct ${visits.visitorId})::int` })
          .from(visits).where(gte(visits.createdAt, from)).groupBy(visits.channel),
        db.select({ channel: users.acquisitionChannel, signups: sql<number>`count(*)::int` })
          .from(users).where(and(gte(users.createdAt, from), sql`${users.acquisitionChannel} is not null`)).groupBy(users.acquisitionChannel),
        db.select({ channel: visits.channel, source: visits.source, visits: sql<number>`count(*)::int`, signups: sql<number>`count(${visits.signedUpUserId})::int` })
          .from(visits).where(gte(visits.createdAt, from)).groupBy(visits.channel, visits.source).orderBy(desc(sql`count(*)`)).limit(20),
        db.select({ campaign: visits.campaign, source: visits.source, medium: visits.medium, visits: sql<number>`count(*)::int`, visitors: sql<number>`count(distinct ${visits.visitorId})::int`, signups: sql<number>`count(${visits.signedUpUserId})::int` })
          .from(visits).where(and(gte(visits.createdAt, from), eq(visits.channel, "utm"))).groupBy(visits.campaign, visits.source, visits.medium).orderBy(desc(sql`count(*)`)).limit(20),
        db.execute(sql`select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)::int as visits
          from visits where channel = 'seo' and created_at >= ${from.toISOString()}::timestamp group by 1 order by 1`),
        db.select({ path: visits.landingPath, visits: sql<number>`count(*)::int` }).from(visits)
          .where(and(gte(visits.createdAt, from), eq(visits.channel, "seo"))).groupBy(visits.landingPath).orderBy(desc(sql`count(*)`)).limit(10),
        db.select({ source: visits.source, visits: sql<number>`count(*)::int` }).from(visits)
          .where(and(gte(visits.createdAt, from), eq(visits.channel, "llm"))).groupBy(visits.source).orderBy(desc(sql`count(*)`)).limit(10),
      ]);
      const signups = new Map(signupsByChannel.map((r) => [r.channel, r.signups]));
      const out = {
        days,
        channels: byChannel.map((c) => ({ ...c, signups: signups.get(c.channel) ?? 0, conversion: c.visitors ? Math.round(((signups.get(c.channel) ?? 0) / c.visitors) * 1000) / 10 : 0 })),
        topSources, topCampaigns, seoDaily, seoLandingPages: seoPages, llmSources,
      };
      await redis.set(cacheKey, JSON.stringify(out), "EX", 60);
      return out;
    });

    // ---------- Campaign links ----------
    app.get("/admin/campaigns", async (req, reply) => {
      const s = await requireRole(auth, req, reply, [...ALL]);
      if (!s) return;
      const q = pageQ.parse(req.query);
      const c = dec(q.cursor);
      const rows = await db.select().from(campaigns)
        .where(c ? or(lt(campaigns.createdAt, c.at), and(eq(campaigns.createdAt, c.at), lt(campaigns.id, c.id))) : undefined)
        .orderBy(desc(campaigns.createdAt), desc(campaigns.id)).limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const codes = page.map((r) => r.code);
      const stats = codes.length
        ? await db.select({ code: visits.campaignCode, visits: sql<number>`count(*)::int`, visitors: sql<number>`count(distinct ${visits.visitorId})::int`, signups: sql<number>`count(${visits.signedUpUserId})::int` })
            .from(visits).where(sql`${visits.campaignCode} in ${codes}`).groupBy(visits.campaignCode)
        : [];
      const by = new Map(stats.map((r) => [r.code, r]));
      return {
        campaigns: page.map((r) => ({
          id: r.id, code: r.code, name: r.name, source: r.source, medium: r.medium, campaign: r.campaign, content: r.content, targetPath: r.targetPath,
          archived: !!r.archivedAt, createdAt: r.createdAt.getTime(),
          shortLink: `${env.PUBLIC_API_URL}/r/${r.code}`,
          fullUrl: buildCampaignUrl(env.WEB_ORIGIN, { ...r, targetPath: r.targetPath }) + `&utm_id=${r.code}`,
          visits: by.get(r.code)?.visits ?? 0, visitors: by.get(r.code)?.visitors ?? 0, signups: by.get(r.code)?.signups ?? 0,
        })),
        nextCursor: rows.length > q.limit ? enc(page[page.length - 1]!.createdAt, page[page.length - 1]!.id) : null,
      };
    });

    app.post("/admin/campaigns", async (req, reply) => {
      const s = await requireRole(auth, req, reply, [...OWNER]);
      if (!s) return;
      const tag = z.string().trim().toLowerCase().min(1).max(60).regex(/^[a-z0-9 _.-]+$/);
      const b = z.object({
        name: z.string().trim().min(2).max(80), source: tag, medium: tag, campaign: tag, content: tag.optional(),
        targetPath: z.string().max(200).regex(/^\/(?!\/)[A-Za-z0-9/_-]*$/).default("/"),
      }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: "invalid", message: "Check the campaign fields." });
      const code = randomBytes(5).toString("hex").slice(0, 7);
      const [row] = await db.insert(campaigns).values({ ...b.data, code, createdBy: s.adminId }).returning();
      await audit(s, "campaign.create", undefined, { code });
      return reply.code(201).send({ code: row!.code, shortLink: `${env.PUBLIC_API_URL}/r/${row!.code}`, fullUrl: buildCampaignUrl(env.WEB_ORIGIN, { ...b.data }) + `&utm_id=${code}` });
    });

    app.post("/admin/campaigns/:id/archive", async (req, reply) => {
      const s = await requireRole(auth, req, reply, [...OWNER]);
      if (!s) return;
      const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!p.success) return reply.code(404).send({ error: "not_found", message: "Not found." });
      await db.update(campaigns).set({ archivedAt: new Date() }).where(eq(campaigns.id, p.data.id));
      await audit(s, "campaign.archive");
      return { ok: true };
    });

    // ---------- Audit log ----------
    app.get("/admin/audit", async (req, reply) => {
      const s = await requireRole(auth, req, reply, [...OWNER]);
      if (!s) return;
      const q = pageQ.parse(req.query);
      const c = dec(q.cursor);
      const rows = await db.select().from(adminAudit)
        .where(c ? or(lt(adminAudit.at, c.at), and(eq(adminAudit.at, c.at), lt(adminAudit.id, c.id))) : undefined)
        .orderBy(desc(adminAudit.at), desc(adminAudit.id)).limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return {
        entries: page.map((r) => ({ id: r.id, adminId: r.adminId, action: r.action, targetUserId: r.targetUserId, meta: r.meta, at: r.at.getTime() })),
        nextCursor: rows.length > q.limit ? enc(page[page.length - 1]!.at, page[page.length - 1]!.id) : null,
      };
    });
  };
}
