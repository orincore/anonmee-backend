import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { isIntent, preferencesSchema } from "../../contracts";
import type { Db } from "../../db/client";
import { preferences } from "../../db/schema";
import { requireUser } from "../auth/auth.routes";

export const normaliseInterests = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()))].slice(0, 12);

export async function loadPreferences(db: Db, userId: string) {
  const [row] = await db.select().from(preferences).where(eq(preferences.userId, userId)).limit(1);
  return row;
}

export function preferencesRoutes(db: Db) {
  return async function (app: FastifyInstance) {
    app.get("/preferences", async (req, reply) => {
      const id = await requireUser(req, reply);
      if (!id) return;
      const p = await loadPreferences(db, id);
      if (!p) return reply.code(404).send({ error: "not_found", message: "No preferences yet." });
      const { userId: _u, updatedAt: _t, ...out } = p;
      return { preferences: { ...out, intents: out.intents.filter(isIntent) } };
    });

    app.put("/preferences", async (req, reply) => {
      const id = await requireUser(req, reply);
      if (!id) return;
      const parsed = preferencesSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: parsed.error.issues[0]?.message });
      const v = { ...parsed.data, interests: normaliseInterests(parsed.data.interests), updatedAt: new Date() };
      await db.update(preferences).set(v).where(eq(preferences.userId, id));
      return { ok: true };
    });
  };
}
