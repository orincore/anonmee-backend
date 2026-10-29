import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { BOT_UUID_PREFIX, SYSTEM_BOT_USER_ID } from "./persona.service";

/**
 * SQL predicate that keeps real people only. AI users are rows in `users` too (so foreign keys hold), but their ids carry a
 * fixed prefix. Every admin and analytics query that counts or lists people goes through this, so bots never skew the numbers.
 */
export function realUser(userId: SQLWrapper): SQL {
  return sql`(${userId}::text not like ${`${BOT_UUID_PREFIX}%`} and ${userId}::text <> ${SYSTEM_BOT_USER_ID})`;
}

/** SQL predicate that matches AI users only, for labelling a chat partner. */
export function botUser(userId: SQLWrapper): SQL {
  return sql`(${userId}::text like ${`${BOT_UUID_PREFIX}%`} or ${userId}::text = ${SYSTEM_BOT_USER_ID})`;
}
