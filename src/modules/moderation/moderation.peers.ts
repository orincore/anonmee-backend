import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { roomMessages } from "../../db/schema";
import type { RedisClient } from "../../lib/redis";
import type { ChatStore } from "../chat/chat.store";
import { GLOBAL_ROOM } from "../chat/rooms.service";
import { groupsRepo } from "../groups/groups.repo";
import type { PeerResolver } from "./moderation.service";

const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

/**
 * Maps (room, alias) back to the account behind it. This is the only place that knows
 * how, and it only answers for people who are actually in the room with the asker.
 */
export function peerResolver(db: Db, redis: RedisClient, chats: ChatStore, flushMessages: () => Promise<unknown>): PeerResolver {
  const groups = groupsRepo(db);
  return {
    async resolve(roomId, alias, requesterId) {
      if (roomId === GLOBAL_ROOM) {
        if (!(await redis.get(`global:alias:${requesterId}`))) return null;
        return redis.get(`global:alias:rev:${alias}`);
      }
      if (!isUuid(roomId)) return null;
      const chat = await chats.get(roomId);
      if (chat) {
        if (!chats.sideOf(chat, requesterId)) return null;
        const other = chats.peerOf(chat, requesterId);
        return other.alias === alias ? other.userId : null;
      }
      if (!(await groups.memberAlias(roomId, requesterId))) return null;
      return groups.userByAlias(roomId, alias);
    },

    async recentEvidence(roomId, reportedId) {
      const chat = isUuid(roomId) ? await chats.get(roomId) : null;
      if (chat) {
        const side = chat.a.userId === reportedId ? chat.a : chat.b;
        return chats.evidenceFrom(roomId, side.alias);
      }
      await flushMessages(); // queued messages must be in the table before we read evidence
      const rows = await db.select({ text: roomMessages.text }).from(roomMessages)
        .where(and(eq(roomMessages.roomId, roomId), eq(roomMessages.userId, reportedId))).orderBy(desc(roomMessages.seq)).limit(15);
      return rows.length ? rows.reverse().map((r) => r.text).join("\n---\n") : null;
    },
  };
}
