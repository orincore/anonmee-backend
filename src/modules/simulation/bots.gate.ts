import { EventEmitter } from "node:events";
import { env } from "../../config/env";
import type { AppServer } from "../../realtime/context";
import type { RedisClient } from "../../lib/redis";
import type { PresenceService } from "../presence/presence.service";
import { botsMayRun } from "./bots.rules";
import { botSwitch } from "./bots.switch";
import { botUsage } from "./usage.meter";

const CACHE_MS = 3000;
/**
 * Messages the AI may write into a room nobody is looking at, so the unread badge reads "9+" for people who are
 * connected but busy elsewhere (in a 1:1 chat, say). After that it stops spending until someone opens the room.
 */
export const BACKLOG_CAP = 10;

/**
 * Decides, cheaply, whether AI chatter may run and whether a given room has a real person in it.
 * Answers are cached for a few seconds; a new connection clears the cache and wakes the sleeping rooms,
 * so the AI starts within moments of someone arriving and stops when the last person leaves.
 */
export class BotGate extends EventEmitter {
  private humans: { at: number; n: number } | null = null;
  private rooms = new Map<string, { at: number; present: boolean }>();
  private viewing = new Map<string, { at: number; viewed: boolean }>();
  /** AI messages written into each room since someone last looked at it. */
  private backlog = new Map<string, number>();

  constructor(private io: AppServer, private presence: PresenceService, private redis: RedisClient) {
    super();
  }

  private async humansOnline(): Promise<number> {
    if (this.humans && Date.now() - this.humans.at < CACHE_MS) return this.humans.n;
    const n = await this.presence.realCount();
    this.humans = { at: Date.now(), n };
    return n;
  }

  /** Master switch: enabled, budget left, and at least one real person online. */
  public async open(): Promise<boolean> {
    if (!(await botSwitch(this.redis).isOn()) || !botUsage.budgetLeft()) return false;
    return botsMayRun({ enabled: true, budgetLeft: true, humansOnline: await this.humansOnline(), maxHumans: env.BOTS_MAX_HUMANS_ONLINE });
  }

  /** Is anyone in this socket room? This server first (free), then every server through the Redis adapter. */
  private async anyoneIn(room: string, cache: Map<string, { at: number; present: boolean }>): Promise<boolean> {
    const hit = cache.get(room);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.present;
    const local = this.io.sockets.adapter.rooms.get(room)?.size ?? 0;
    const present = local > 0 || (await this.io.in(room).fetchSockets()).length > 0;
    cache.set(room, { at: Date.now(), present });
    return present;
  }

  /**
   * Should the AI write into this room (`r:global`, `r:<groupId>`)? Yes while someone is looking at it. If nobody is
   * but people are connected elsewhere, only until a small backlog has built up. Nobody connected: no.
   */
  public async hasAudience(room: string): Promise<boolean> {
    if (!(await this.open())) return false;
    const viewed = await this.anyoneIn(room.replace(/^r:/, "view:"), this.viewingCache);
    this.viewing.set(room, { at: Date.now(), viewed });
    if (viewed) {
      this.backlog.set(room, 0); // they will see everything that is there now
      return true;
    }
    if (!(await this.anyoneIn(room, this.rooms))) return false;
    return (this.backlog.get(room) ?? 0) < BACKLOG_CAP;
  }

  private viewingCache = new Map<string, { at: number; present: boolean }>();

  /** The AI wrote a message into `room`. If nobody was looking, it counts towards the backlog. */
  public notePosted(room: string) {
    if (this.viewing.get(room)?.viewed) return;
    this.backlog.set(room, (this.backlog.get(room) ?? 0) + 1);
  }

  /** A person just connected: forget cached answers and wake every room that was asleep. */
  public wake() {
    this.humans = null;
    this.rooms.clear();
    this.viewingCache.clear();
    this.emit("wake");
  }
}
