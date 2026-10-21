import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../../config/env";
import { loginSchema, registerSchema } from "../../contracts";
import { ACCESS_TTL_S, REFRESH_TTL_S, verifyAccess } from "../../lib/tokens";
import { AuthError, type authService } from "./auth.service";

type Service = ReturnType<typeof authService>;
const secure = env.NODE_ENV === "production";
const cookie = (maxAge: number, path = "/") => ({ httpOnly: true, secure, sameSite: "lax" as const, path, maxAge });

function setSession(reply: FastifyReply, s: { access: string; refresh: string }) {
  reply.setCookie("access", s.access, cookie(ACCESS_TTL_S));
  reply.setCookie("refresh", s.refresh, cookie(REFRESH_TTL_S, "/auth"));
}

/** Reads the access cookie and returns the user id, or sends 401. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const token = req.cookies.access;
  const id = token ? await verifyAccess(token) : null;
  if (!id) {
    await reply.code(401).send({ error: "unauthorized", message: "Please log in." });
    return null;
  }
  return id;
}

export function authRoutes(svc: Service, hooks: { onAccountDeleted?: (userId: string) => void } = {}) {
  return async function (app: FastifyInstance) {
    const limited = { config: { rateLimit: { max: process.env.NODE_ENV === "test" ? 1000 : 10, timeWindow: "1 minute" } } };

    app.post("/auth/register", limited, async (req, reply) => {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: parsed.error.issues[0]?.message, field: parsed.error.issues[0]?.path[0] });
      const { user, ...session } = await svc.register(parsed.data);
      setSession(reply, session);
      return reply.code(201).send({ user });
    });

    app.post("/auth/login", limited, async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Enter your email and password." });
      const { user, ...session } = await svc.login(parsed.data, req.ip);
      setSession(reply, session);
      return { user };
    });

    app.post("/auth/refresh", async (req, reply) => {
      const token = req.cookies.refresh;
      if (!token) throw new AuthError(401, "bad_refresh", "Please log in again.");
      const { user, ...session } = await svc.refresh(token);
      setSession(reply, session);
      return { user };
    });

    app.post("/auth/logout", async (req, reply) => {
      const id = await requireUser(req, reply);
      if (!id) return;
      await svc.logout(id);
      reply.clearCookie("access", { path: "/" }).clearCookie("refresh", { path: "/auth" });
      return { ok: true };
    });

    app.post("/auth/delete-account", { config: { rateLimit: { max: process.env.NODE_ENV === "test" ? 1000 : 5, timeWindow: "1 hour" } } }, async (req, reply) => {
      const id = await requireUser(req, reply);
      if (!id) return;
      const parsed = z.object({ password: z.string().min(1).max(128) }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Enter your password to confirm." });
      await svc.deleteAccount(id, parsed.data.password);
      hooks.onAccountDeleted?.(id); // cut off any open chats
      reply.clearCookie("access", { path: "/" }).clearCookie("refresh", { path: "/auth" });
      return { ok: true };
    });

    app.get("/auth/me", async (req, reply) => {
      const id = await requireUser(req, reply);
      if (!id) return;
      return { user: await svc.me(id) };
    });
  };
}
