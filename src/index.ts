import { env } from "./config/env";
import { db } from "./db/client";
import { redis } from "./lib/redis";
import { buildServer } from "./server";

const { app } = await buildServer(db, redis);
await app.listen({ port: env.SERVER_PORT, host: "0.0.0.0" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    redis.disconnect();
    process.exit(0);
  });
}
