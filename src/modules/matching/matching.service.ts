import { eq } from "drizzle-orm";
import { ageFromDob, isIntent, type Intent, type PeerView } from "../../contracts";
import type { Db } from "../../db/client";
import { matches, preferences, users } from "../../db/schema";
import { randomAlias } from "../../lib/alias";
import type { RedisClient } from "../../lib/redis";
import type { ChatStore } from "../chat/chat.store";
import type { ModerationRepo } from "../moderation/moderation.repo";
import { sharedIntents } from "./matching.rules";
import { pickPartner } from "./matching.score";
import type { Ticket } from "./matching.types";

const QUEUE = "mm:queue";
const WAIT_TIMEOUT_MS = 60_000;
const SCAN = 200;
const COOLDOWN_S = 10 * 60;

const kTicket = (uid: string) => `mm:ticket:${uid}`;
const kRecent = (uid: string) => `mm:recent:${uid}`;

/** Atomic pairing: succeeds only if both tickets are still waiting, so nobody is ever matched twice. */
const PAIR_LUA = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) and redis.call('ZSCORE', KEYS[1], ARGV[2]) then
  redis.call('ZREM', KEYS[1], ARGV[1], ARGV[2])
  redis.call('DEL', KEYS[2], KEYS[3])
  return 1
end
return 0`;

type Stored = Omit<Ticket, "blocked" | "recentPartners"> & { blocked: string[]; recentPartners: string[] };
const revive = (s: Stored): Ticket => ({ ...s, blocked: new Set(s.blocked), recentPartners: new Set(s.recentPartners) });

export interface MatchNotifier {
  found(userId: string, p: { chatId: string; you: PeerView; peer: PeerView; intent: Intent }): void;
  timeout(userId: string): void;
}

export class MatchError extends Error {
  constructor(readonly code: "in_chat" | "banned" | "no_prefs", message: string) {
    super(message);
  }
}

export function matchingService(deps: { db: Db; redis: RedisClient; chats: ChatStore; moderation: ModerationRepo; notify: MatchNotifier; onMatched?: (intent: Intent) => void }) {
  const { db, redis, chats, moderation, notify, onMatched } = deps;

  async function buildTicket(userId: string): Promise<Ticket> {
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u || u.bannedAt) throw new MatchError("banned", "This account cannot match.");
    const [p] = await db.select().from(preferences).where(eq(preferences.userId, userId)).limit(1);
    const intents = p?.intents.filter(isIntent) ?? [];
    if (!p || intents.length === 0) throw new MatchError("no_prefs", "Choose what you are looking for first.");
    return {
      userId, gender: u.gender, age: ageFromDob(u.dateOfBirth), intents, wantGenders: p.wantGenders,
      minAge: p.minAge, maxAge: p.maxAge, interests: p.interests,
      blocked: await moderation.blockedEitherWay(userId),
      recentPartners: new Set(await redis.smembers(kRecent(userId))),
      enqueuedAt: Date.now(),
    };
  }

  async function load(ids: string[]): Promise<Ticket[]> {
    if (ids.length === 0) return [];
    const raw = await redis.mget(ids.map(kTicket));
    return raw.filter((r): r is string => !!r).map((r) => revive(JSON.parse(r) as Stored));
  }

  async function createChat(a: Ticket, b: Ticket) {
    const sideA = { userId: a.userId, alias: randomAlias(), gender: a.gender, age: a.age };
    let aliasB = randomAlias();
    while (aliasB === sideA.alias) aliasB = randomAlias();
    const sideB = { userId: b.userId, alias: aliasB, gender: b.gender, age: b.age };
    const chat = await chats.create(sideA, sideB);
    const intent = sharedIntents(a, b)[0] ?? "other";
    await redis.multi()
      .sadd(kRecent(a.userId), b.userId).expire(kRecent(a.userId), COOLDOWN_S)
      .sadd(kRecent(b.userId), a.userId).expire(kRecent(b.userId), COOLDOWN_S)
      .exec();
    await db.insert(matches).values({
      id: chat.id, userAId: a.userId, userBId: b.userId, intent, waitMs: Math.max(Date.now() - Math.min(a.enqueuedAt, b.enqueuedAt), 0),
    });
    const viewA = chats.toPeerView(sideA);
    const viewB = chats.toPeerView(sideB);
    notify.found(a.userId, { chatId: chat.id, you: viewA, peer: viewB, intent });
    notify.found(b.userId, { chatId: chat.id, you: viewB, peer: viewA, intent });
    onMatched?.(intent);
  }

  /** Tries to pair one waiting user. Safe to call from many servers at once. */
  async function tryMatch(userId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [seeker] = await load([userId]);
      if (!seeker) return false; // already matched or left
      const ids = (await redis.zrange(QUEUE, 0, SCAN - 1)).filter((id) => id !== userId);
      const partner = pickPartner(seeker, await load(ids), Date.now());
      if (!partner) return false;
      const won = await redis.eval(PAIR_LUA, 3, QUEUE, kTicket(userId), kTicket(partner.userId), userId, partner.userId);
      if (won === 1) {
        await createChat(seeker, partner);
        return true;
      }
      // Someone else grabbed the partner first. Look again.
    }
    return false;
  }

  return {
    async join(userId: string): Promise<void> {
      if (await chats.activeChatId(userId)) throw new MatchError("in_chat", "Finish your current chat first.");
      const t = await buildTicket(userId);
      const stored: Stored = { ...t, blocked: [...t.blocked], recentPartners: [...t.recentPartners] };
      await redis.multi().set(kTicket(userId), JSON.stringify(stored), "EX", 120).zadd(QUEUE, t.enqueuedAt, userId).exec();
      await tryMatch(userId);
    },

    async leave(userId: string): Promise<void> {
      await redis.multi().zrem(QUEUE, userId).del(kTicket(userId)).exec();
    },

    isWaiting: async (userId: string) => (await redis.zscore(QUEUE, userId)) !== null,
    tryMatch,

    /** Run every second: pairs anyone whose partner arrived later, and times out long waits. */
    async sweep(): Promise<void> {
      const ids = await redis.zrange(QUEUE, 0, SCAN - 1);
      const now = Date.now();
      const tickets = await load(ids);
      // A queued id with no ticket data (expired) would clog the line, so drop it.
      const have = new Set(tickets.map((t) => t.userId));
      const orphans = ids.filter((id) => !have.has(id));
      if (orphans.length) await redis.zrem(QUEUE, ...orphans);
      for (const t of tickets) {
        if (now - t.enqueuedAt > WAIT_TIMEOUT_MS) {
          await this.leave(t.userId);
          notify.timeout(t.userId);
          continue;
        }
        await tryMatch(t.userId);
      }
    },
  };
}
