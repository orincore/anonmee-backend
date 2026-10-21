import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { env } from "../config/env";

const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 30 * 24 * 3600;

export async function signAccess(userId: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId)
    .setIssuedAt().setExpirationTime(`${ACCESS_TTL_S}s`).sign(accessKey);
}

/** Returns the user id, or null for any invalid or expired token. */
export async function verifyAccess(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, accessKey, { algorithms: ["HS256"] });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/** Refresh tokens are opaque random strings; only their hash is stored. */
export function newRefreshToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefresh(token) };
}
export const hashRefresh = (token: string) => createHash("sha256").update(token).digest("hex");
