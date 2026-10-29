import { env } from "../../config/env";
import type { ChatMessage } from "../../contracts";
import type { Db } from "../../db/client";
import { chatReviewMessages } from "../../db/schema";
import type { Chat, ChatSide } from "./chat.store";

const FLUSH_MS = 1000;

/**
 * Keeps a record of every 1:1 chat (with a person or an AI user) for safety review and legal requests, in batches so a chat
 * never waits on Postgres. Off unless CHAT_REVIEW_ENABLED=true; do not turn it on before Privacy, FAQ and llms.txt say it is kept. A failed write is logged and
 * dropped; it must never break the chat.
 */
export function chatReview(db: Db) {
  let queue: (typeof chatReviewMessages.$inferInsert)[] = [];
  let timer: NodeJS.Timeout | null = null;

  async function flush() {
    timer = null;
    const rows = queue;
    queue = [];
    if (!rows.length) return;
    try {
      await db.insert(chatReviewMessages).values(rows).onConflictDoNothing();
    } catch (err) {
      console.error("chat review write failed", err);
    }
  }

  return {
    hook(chat: Chat, from: ChatSide, msg: ChatMessage) {
      if (!env.CHAT_REVIEW_ENABLED) return;
      queue.push({ chatId: chat.id, seq: msg.seq, userId: from.userId, alias: from.alias, text: msg.text.slice(0, 2000), createdAt: new Date(msg.at) });
      timer ??= setTimeout(() => void flush(), FLUSH_MS);
    },
    flush,
  };
}
