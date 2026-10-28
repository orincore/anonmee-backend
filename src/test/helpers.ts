import { like } from "drizzle-orm";
import { io as connect, type Socket } from "socket.io-client";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client";
import { users } from "../db/schema";
import { redis } from "../lib/redis";
import { buildServer } from "../server";

export interface TestUser {
  userId: string;
  cookie: string;
  socket?: Socket;
}

export async function startTestServer() {
  const { app, rt } = await buildServer(db, redis);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return { app, rt, url: `http://127.0.0.1:${port}` };
}

export async function makeUser(
  app: FastifyInstance, tag: string, n: string,
  o: { gender?: string; dob?: string; prefs?: Record<string, unknown> } = {},
): Promise<TestUser> {
  const res = await app.inject({
    method: "POST", url: "/auth/register",
    payload: {
      email: `${tag}-${n}@example.com`, password: "correct horse 9", username: `${tag}_${n}`,
      gender: o.gender ?? "female", dateOfBirth: o.dob ?? "1998-06-01", confirmAdult: true,
      // Every test user is a different person on a different phone: one account per device is a real rule.
      deviceId: `dev-${tag}-${n}`.padEnd(16, "0").slice(0, 64), deviceFingerprint: `fp-${tag}-${n}`.padEnd(16, "0").slice(0, 64),
    },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const access = res.cookies.find((c) => c.name === "access")!.value;
  const cookie = `access=${access}`;
  if (o.prefs) {
    const put = await app.inject({ method: "PUT", url: "/preferences", payload: o.prefs as object, headers: { cookie } });
    if (put.statusCode !== 200) throw new Error(`prefs failed: ${put.body}`);
  }
  const [row] = await db.select({ id: users.id }).from(users).where(like(users.email, `${tag}-${n}@%`));
  return { userId: row!.id, cookie };
}

export function openSocket(url: string, u: TestUser, ns = ""): Socket {
  const s = connect(url + ns, {
    transports: ["websocket"], forceNew: true, reconnection: false,
    extraHeaders: { cookie: u.cookie, origin: process.env.WEB_ORIGIN! },
  });
  u.socket = s;
  return s;
}

export const once = <T = any>(s: Socket, ev: string, ms = 5000): Promise<T> =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    s.once(ev, (d: T) => { clearTimeout(t); res(d); });
  });

export const emitAck = <T = any>(s: Socket, ev: string, data: unknown = {}): Promise<T> =>
  new Promise((res) => s.emit(ev, data, res));

export const connected = (s: Socket) => new Promise<void>((res, rej) => {
  s.once("connect", () => res());
  s.once("connect_error", (e) => rej(e));
});

export async function cleanTag(tag: string) {
  await db.delete(users).where(like(users.email, `${tag}-%`));
  for (const pat of ["mm:*", "chat:*", "presence:*", "thr:login:*"]) {
    const keys = await redis.keys(pat);
    if (keys.length) await redis.del(...keys);
  }
}
