import type { ZodType } from "zod";
import { EV } from "../contracts";
import type { Ack, AppSocket } from "./context";
import { tokenBucket } from "./limiter";

export class HandlerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Registers a socket event with the three guarantees every event needs: the payload is parsed
 * with its zod contract, the socket is rate limited, and failures come back as a clean ack
 * instead of a crash. A socket that keeps sending junk is disconnected.
 */
export function handle<T>(
  socket: AppSocket,
  event: string,
  schema: ZodType<T>,
  fn: (data: T, ack: Ack) => Promise<void> | void,
) {
  const bucket = socketBuckets.get(socket) ?? socketBuckets.set(socket, tokenBucket(30, 80)).get(socket)!;
  let strikes = 0;
  socket.on(event, async (raw: unknown, ack?: Ack) => {
    const reply: Ack = typeof ack === "function" ? ack : () => {};
    if (!bucket.take()) {
      return reply({ ok: false, error: "rate_limited", message: "Slow down a little." });
    }
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      if (++strikes >= 20) socket.disconnect(true);
      return reply({ ok: false, error: "invalid", message: "That request was not valid." });
    }
    try {
      await fn(parsed.data, reply);
    } catch (err) {
      if (err instanceof HandlerError) return reply({ ok: false, error: err.code, message: err.message });
      socket.emit(EV.error, { message: "Something went wrong." });
      reply({ ok: false, error: "server_error", message: "Something went wrong. Please try again." });
      console.error("socket handler failed", event, err);
    }
  });
}
const socketBuckets = new WeakMap<AppSocket, ReturnType<typeof tokenBucket>>();
