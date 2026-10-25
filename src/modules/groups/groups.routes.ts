import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ageFromDob, createGroupSchema, roomReadSchema } from "../../contracts";
import type { Db } from "../../db/client";
import { randomAlias } from "../../lib/alias";
import type { RedisClient } from "../../lib/redis";
import { normaliseTag } from "../../lib/tags";
import { activityFor } from "../../lib/activity";
import { requireUser } from "../auth/auth.routes";
import { moderationRepo } from "../moderation/moderation.repo";
import { loadPreferences } from "../preferences/preferences.routes";
import { GroupGone, groupsRepo, type GroupRow } from "./groups.repo";
import { recommendGroups, type GroupCandidate } from "./groups.recommend";
import { reactionsService } from "../chat/reactions.service";
import { roomsService, type RoomsService } from "../chat/rooms.service";

export interface GroupView {
  id: string;
  title: string;
  topic: string;
  description: string;
  memberCount: number;
  createdAt: number;
}
/** Explicit mapper: the owner id and every other column stay private. */
export const toGroupView = (g: GroupRow): GroupView => ({
  id: g.id, title: g.title, topic: g.topic, description: g.description,
  memberCount: g.memberCount, createdAt: g.createdAt.getTime(),
});

const MAX_NEW_GROUPS_PER_HOUR = 3;
const idParam = z.object({ id: z.string().uuid() });

function encodeCursor(g: { createdAt: Date; id: string }) {
  return Buffer.from(`${g.createdAt.getTime()}:${g.id}`).toString("base64url");
}
function decodeCursor(c: string | undefined) {
  if (!c) return undefined;
  const [ms, id] = Buffer.from(c, "base64url").toString().split(":");
  const at = new Date(Number(ms));
  return Number.isNaN(at.getTime()) || !id ? undefined : { at, id };
}

export function groupsRoutes(deps: { db: Db; redis: RedisClient; rooms?: RoomsService; onCreated: (g: GroupView) => void; onLeft?: (groupId: string, userId: string) => void }) {
  const { db, redis } = deps;
  const repo = groupsRepo(db);
  const mod = moderationRepo(db);
  const rooms = deps.rooms ?? roomsService(db, redis, reactionsService(redis));

  async function candidates(): Promise<GroupCandidate[]> {
    const hit = await redis.get("groups:candidates");
    if (hit) return JSON.parse(hit) as GroupCandidate[];
    const fresh = await repo.feedCandidates();
    const busy = await activityFor(redis, fresh.map((g) => g.id));
    for (const g of fresh) g.messagesLast10m = busy.get(g.id) ?? 0;
    await redis.set("groups:candidates", JSON.stringify(fresh), "EX", 5);
    return fresh;
  }

  return async function (app: FastifyInstance) {
    app.get("/rooms/unread", async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      return rooms.getUnreads(uid);
    });

    app.post("/rooms/read", async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      const p = roomReadSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "invalid", message: "Bad room read." });
      return rooms.markRead(uid, p.data.roomId, p.data.seq);
    });

    app.post("/groups", async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      const key = String(req.headers["idempotency-key"] ?? "");
      if (key.length < 8 || key.length > 64) return reply.code(400).send({ error: "invalid", message: "Missing request key." });
      const parsed = createGroupSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: parsed.error.issues[0]?.message, field: parsed.error.issues[0]?.path[0] });

      // A retry with the same key returns the group already made, never a second one.
      const idemKey = `idem:group:${uid}:${key}`;
      const reserved = await redis.set(idemKey, "pending", "EX", 3600, "NX");
      if (reserved !== "OK") {
        const existing = await redis.get(idemKey);
        const g = existing && existing !== "pending" ? await repo.get(existing) : undefined;
        return g ? { group: toGroupView(g) } : reply.code(409).send({ error: "in_progress", message: "Still creating, one moment." });
      }
      const used = await redis.incr(`rate:group:${uid}`);
      if (used === 1) await redis.expire(`rate:group:${uid}`, 3600);
      if (used > MAX_NEW_GROUPS_PER_HOUR) {
        await redis.del(idemKey);
        return reply.code(429).send({ error: "rate_limited", message: "You can create 3 groups an hour. Try again later." });
      }
      try {
        const created = await repo.create(uid, { ...parsed.data, topic: normaliseTag(parsed.data.topic) }, randomAlias());
        await redis.set(idemKey, created.id, "EX", 3600);
        await redis.del("groups:candidates");
        const view = toGroupView(created);
        deps.onCreated(view);
        return reply.code(201).send({ group: view });
      } catch (e) {
        await redis.del(idemKey);
        throw e;
      }
    });

    // Recommended for this person, best first.
    app.get("/groups/feed", async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      const prefs = await loadPreferences(db, uid);
      const viewer = { userId: uid, interests: prefs?.interests ?? [], joinedGroupIds: await repo.joinedIds(uid), blockedUserIds: await mod.blockedEitherWay(uid) };
      const picked = recommendGroups(await candidates(), viewer, Date.now(), 20);
      // The ranking works on slim candidates; the cards need titles and descriptions, so fetch those in rank order.
      const rows = new Map((await repo.getMany(picked.map((g) => g.id))).map((r) => [r.id, r]));
      return { groups: picked.flatMap((g) => (rows.has(g.id) ? [toGroupView(rows.get(g.id)!)] : [])) };
    });

    // Public directory for SEO, crawlers, and guest browsing (no auth required)
    app.get("/groups/public", async (req, reply) => {
      const q = z.object({ topic: z.string().max(24).optional(), cursor: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid", message: "Bad filter." });
      const rows = await repo.list({ topic: q.data.topic ? normaliseTag(q.data.topic) : undefined, cursor: decodeCursor(q.data.cursor), limit: q.data.limit });
      const page = rows.slice(0, q.data.limit);
      return { groups: page.map(toGroupView), nextCursor: rows.length > q.data.limit ? encodeCursor(page[page.length - 1]!) : null };
    });

    // Public group preview for SEO crawlers and unauthenticated visitors
    app.get("/groups/:id/public", async (req, reply) => {
      const p = idParam.safeParse(req.params);
      const g = p.success ? await repo.get(p.data.id) : undefined;
      if (!g || g.closedAt) return reply.code(404).send({ error: "not_found", message: "That group is gone." });
      return { group: toGroupView(g) };
    });

    // Public stats for Global Chat room SEO
    app.get("/groups/global/stats", async () => {
      const onlineCount = await redis.scard("presence:online").catch(() => 0);
      return {
        roomId: "global",
        title: "Everyone (Global Chat)",
        description: "Open to all of Anonmee — live anonymous public chat across the globe.",
        activeParticipants: Math.max(onlineCount, 24),
        trendingTopics: ["dating", "friendship", "confessions", "deep-talks", "open-chat"],
      };
    });

    app.get("/groups", async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      const q = z.object({ topic: z.string().max(24).optional(), cursor: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid", message: "Bad filter." });
      const rows = await repo.list({ topic: q.data.topic ? normaliseTag(q.data.topic) : undefined, cursor: decodeCursor(q.data.cursor), limit: q.data.limit });
      const page = rows.slice(0, q.data.limit);
      return { groups: page.map(toGroupView), nextCursor: rows.length > q.data.limit ? encodeCursor(page[page.length - 1]!) : null };
    });

    app.get("/groups/:id", async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      const p = idParam.safeParse(req.params);
      const g = p.success ? await repo.get(p.data.id) : undefined;
      if (!g || g.closedAt) return reply.code(404).send({ error: "not_found", message: "That group is gone." });
      return { group: toGroupView(g), alias: await repo.memberAlias(g.id, uid) };
    });

    app.get("/groups/:id/members", async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      const p = idParam.safeParse(req.params);
      if (!p.success || !(await repo.memberAlias(p.data.id, uid))) return reply.code(403).send({ error: "forbidden", message: "Join the group to see who is in it." });
      const q = z.object({ cursor: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid", message: "Bad page." });
      const c = decodeCursor(q.data.cursor);
      const rows = await repo.members(p.data.id, q.data.limit, c ? { at: c.at, userId: c.id } : undefined);
      const page = rows.slice(0, q.data.limit);
      const last = page[page.length - 1];
      return {
        members: page.map((m) => ({ alias: m.alias, gender: m.gender, age: ageFromDob(m.dob) })),
        nextCursor: rows.length > q.data.limit && last ? Buffer.from(`${last.at.getTime()}:${last.userId}`).toString("base64url") : null,
      };
    });

    app.post("/groups/:id/join", async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      const p = idParam.safeParse(req.params);
      const g = p.success ? await repo.get(p.data.id) : undefined;
      if (!g || g.closedAt) return reply.code(404).send({ error: "not_found", message: "That group is gone." });
      if ((await mod.blockedEitherWay(uid)).has(g.ownerId)) return reply.code(403).send({ error: "unavailable", message: "This group is not available to you." });
      try {
        const { alias, alreadyMember } = await repo.join(g.id, uid, randomAlias());
        if (!alreadyMember) {
          const cur = await rooms.getSeq(g.id);
          await rooms.markRead(uid, g.id, cur);
        }
        await redis.del("groups:candidates");
        return { group: toGroupView({ ...g, memberCount: g.memberCount + (alreadyMember ? 0 : 1) }), alias };
      } catch (e) {
        if (e instanceof GroupGone) return reply.code(404).send({ error: "not_found", message: "That group is gone." });
        throw e;
      }
    });

    app.post("/groups/:id/leave", async (req, reply) => {
      const uid = await requireUser(req, reply);
      if (!uid) return;
      const p = idParam.safeParse(req.params);
      if (!p.success) return reply.code(404).send({ error: "not_found", message: "That group is gone." });
      await repo.leave(p.data.id, uid);
      await redis.del(`member:${p.data.id}:${uid}`);
      await redis.del(`user:${uid}:read:${p.data.id}`);
      await redis.del("groups:candidates");
      deps.onLeft?.(p.data.id, uid);
      return { ok: true };
    });
  };
}
