import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env";
import * as schema from "./schema";

/** Test hook: lets a test assert how many queries a flow costs. Costs nothing outside tests. */
export const queryStats = { count: 0 };

const sql = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  idle_timeout: 30,
  connect_timeout: 10,
  // A runaway query is cut off instead of piling up and starving the pool.
  // Always UTC: timestamp columns carry no zone, so the app and the database must agree on one clock.
  connection: { TimeZone: "UTC", statement_timeout: 10_000, idle_in_transaction_session_timeout: 15_000 },
  debug: env.NODE_ENV === "test" ? () => void queryStats.count++ : undefined,
});
export const db = drizzle(sql, { schema });
export type Db = typeof db;
