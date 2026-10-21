import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { authenticator } from "otplib";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../config/env";
import type { Db } from "../../db/client";
import { admins } from "../../db/schema";
import { decrypt } from "../../lib/crypto";
import { hashPassword, verifyPassword } from "../../lib/password";
import type { RedisClient } from "../../lib/redis";
import type { LoginThrottle } from "../../lib/throttle";

export type AdminRole = "owner" | "moderator" | "analyst";
export interface AdminSession {
  adminId: string;
  role: AdminRole;
  email: string;
}
export const ADMIN_TTL_S = 8 * 3600;
const key = new TextEncoder().encode(env.ADMIN_JWT_SECRET);
const DUMMY = hashPassword("admin-timing-equaliser");
authenticator.options = { window: 1 };

export class AdminAuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function adminAuth(db: Db, redis: RedisClient, throttle: LoginThrottle) {
  return {
    async login(email: string, password: string, code: string, ip: string) {
      const id = `admin:${email.toLowerCase()}`;
      if (await throttle.isLocked(id, ip)) throw new AdminAuthError(429, "Too many tries. Wait 15 minutes.");
      const [a] = await db.select().from(admins).where(eq(admins.email, email.toLowerCase())).limit(1);
      const passOk = await verifyPassword(a?.passwordHash ?? (await DUMMY), password);
      // Password and code are checked together so a wrong answer never says which one was wrong.
      const codeOk = a ? authenticator.check(code, decrypt(a.totpSecretEnc)) : false;
      // A code works once, even inside its 30 second window.
      const fresh = codeOk && a && (await redis.set(`admin:totp:${a.id}:${code}`, "1", "EX", 120, "NX")) === "OK";
      if (!a || a.disabledAt || !passOk || !fresh) {
        await throttle.fail(id, ip);
        throw new AdminAuthError(401, "Email, password or code is wrong.");
      }
      await throttle.succeed(id, ip);
      await db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, a.id));
      const token = await new SignJWT({ role: a.role, email: a.email }).setProtectedHeader({ alg: "HS256" })
        .setSubject(a.id).setIssuedAt().setExpirationTime(`${ADMIN_TTL_S}s`).sign(key);
      return { token, admin: { email: a.email, role: a.role as AdminRole } };
    },

    /** Reads the admin cookie. Role and disabled state are re-checked in the database on every request. */
    async session(req: FastifyRequest): Promise<AdminSession | null> {
      const token = req.cookies.admin_session;
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
        const [a] = await db.select({ id: admins.id, role: admins.role, email: admins.email, disabledAt: admins.disabledAt })
          .from(admins).where(eq(admins.id, payload.sub!)).limit(1);
        return a && !a.disabledAt ? { adminId: a.id, role: a.role as AdminRole, email: a.email } : null;
      } catch {
        return null;
      }
    },
  };
}

/** Sends 401/403 and returns null unless the caller is a signed-in admin with one of the roles. */
export async function requireRole(
  auth: ReturnType<typeof adminAuth>, req: FastifyRequest, reply: FastifyReply, roles: AdminRole[],
): Promise<AdminSession | null> {
  const s = await auth.session(req);
  if (!s) {
    await reply.code(401).send({ error: "unauthorized", message: "Please sign in." });
    return null;
  }
  if (!roles.includes(s.role)) {
    await reply.code(403).send({ error: "forbidden", message: "You do not have access to this." });
    return null;
  }
  return s;
}
