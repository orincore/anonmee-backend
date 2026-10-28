import type { ChatMessage } from "../../contracts";
import { isRowdy } from "./chat.quality";
import { mixStances } from "./chat.crowd";
import { activeTopic, updateTopic, type TopicHold } from "./topic.hold";
import { generateScript } from "./together.service";
import type { ScriptLine, SimulatedPersona, SimulationMessageContext } from "./simulation.types";

/** What a room has to provide so a script can play in it. */
export interface RoomScriptHost {
  roomKey: string;
  groupTitle?: string;
  topicSeed?: string;
  /** Personas allowed to speak here. */
  pool(): Promise<SimulatedPersona[]>;
  /** Newest messages, oldest first. */
  history(): Promise<ChatMessage[]>;
  /** Shows typing, then posts. Returns the posted message, or null if nothing was posted. */
  say(persona: SimulatedPersona, text: string, replyToId?: string): Promise<ChatMessage | null>;
  isPersonaAlias(alias: string): boolean;
  /** The topic a real person raised and the room is still on, if any. */
  topic?(): string | null;
  /** True while a real person is in this room. Nothing is generated or posted without one. */
  hasAudience(): Promise<boolean>;
  /** Calls `cb` when a person arrives, so a sleeping room starts at once. Returns an unsubscribe function. */
  onWake?(cb: () => void): () => void;
}

export interface Pace {
  /** Random wait between two lines, on top of the typing time. */
  minGapMs: number;
  maxGapMs: number;
  /** How long after a real person spoke the script stays quiet, so their reply comes first. */
  humanGraceMs: number;
}

interface Batch {
  cast: SimulatedPersona[];
  lines: ScriptLine[];
  /** Message ids of lines already posted, by line index, so later lines can quote them. */
  ids: (string | undefined)[];
  next: number;
}

const BATCH = 10;
const PREFETCH_AT = 3; // start writing the next batch when this many lines are left
const CAST_SIZE = 4;
const IDLE_CHECK_MS = 4000; // while nobody is in the room: one cheap check, no Redis history, no model

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Human rhythm: mostly steady, sometimes a quick back-and-forth, now and then a lull. */
export function nextGapMs(pace: { minGapMs: number; maxGapMs: number }, sameSpeakerNext: boolean, roll = Math.random()): number {
  if (sameSpeakerNext) return 800 + roll * 1400; // a double-text lands almost at once
  if (roll < 0.12) return 14_000 + roll * 100_000; // a lull of 14 to 26 seconds
  if (roll < 0.32) return pace.minGapMs * (0.5 + roll); // quick exchange
  return pace.minGapMs + ((roll - 0.32) / 0.68) * (pace.maxGapMs - pace.minGapMs);
}
const left = (b: Batch | null) => (b ? b.lines.length - b.next : 0);

/**
 * Plays generated conversations in one room. A batch of 10 lines is written in a single model call
 * and posted one by one at random gaps; the next batch is written while the current one is still playing,
 * so the slow model call never shows up as a pause. A real person speaking discards the stale script.
 */
export class RoomScript {
  private current: Batch | null = null;
  private upcoming: Batch | null = null;
  private generating = false;
  private epoch = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private cast: SimulatedPersona[] = [];
  private asleep = false;
  private unsubscribe: (() => void) | null = null;
  /** The topic a real person raised. Held for 15 minutes after they last spoke about it, not replaced by every message. */
  private hold: TopicHold | null = null;

  constructor(private host: RoomScriptHost, private pace: Pace) {}

  public start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = this.host.onWake?.(() => this.wake()) ?? null;
    this.schedule(rand(2000, 5000));
  }

  public stop() {
    this.stopped = true;
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Someone arrived: run the next step now instead of waiting out the idle check. */
  private wake() {
    if (this.stopped || !this.asleep) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(300);
  }

  /**
   * A real person spoke. What was planned no longer fits, so it is dropped. What they said becomes the room's topic if
   * it is a real one, or keeps the current topic going; it only changes when they clearly change the subject.
   */
  public noteHuman(text: string) {
    this.hold = updateTopic(this.hold, text.replace(/["\n]+/g, " "), Date.now());
    this.interrupt();
  }

  /** The topic the room should still be on, or null once it has been quiet for 15 minutes. */
  public currentTopic(): string | null {
    return activeTopic(this.hold, Date.now())?.topic ?? null;
  }

  /** A real person spoke: what was planned no longer fits the conversation. */
  public interrupt() {
    this.epoch++;
    this.current = null;
    this.upcoming = null;
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer); // exactly one pending tick, ever
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    let waitingForModel = false;
    let idle = false;
    let sameSpeakerNext = false;
    try {
      // Nobody is looking at this room: no model calls, no posts. Drop what was planned, it will be stale.
      if (!(await this.host.hasAudience())) {
        if (!this.asleep) this.interrupt();
        this.asleep = true;
        idle = true;
        return;
      }
      this.asleep = false;
      const recent = await this.host.history();
      const last = recent[recent.length - 1];
      const humanJustSpoke = !!last && !this.host.isPersonaAlias(last.alias) && Date.now() - last.at < this.pace.humanGraceMs;
      if (!humanJustSpoke) {
        if (left(this.current) === 0 && this.upcoming) this.promote();
        if (!this.generating && !this.upcoming && left(this.current) <= PREFETCH_AT) void this.refill(recent);
        if (this.current && left(this.current) > 0) {
          const posted = this.current.lines[this.current.next]!;
          await this.postNext(this.current);
          const upcoming = this.current?.lines[this.current.next];
          sameSpeakerNext = !!upcoming && upcoming.speaker === posted.speaker;
        } else waitingForModel = true;
      }
    } catch (err) {
      console.error("Room script error:", err);
    } finally {
      // Empty room: a slow, free check. Waiting on the model: look again soon. Otherwise a human pace.
      this.schedule(idle ? IDLE_CHECK_MS : waitingForModel ? 1500 : nextGapMs(this.pace, sameSpeakerNext));
    }
  }

  private promote() {
    this.current = this.upcoming;
    this.upcoming = null;
  }

  private async postNext(batch: Batch) {
    const epoch = this.epoch;
    const index = batch.next++;
    const line = batch.lines[index]!;
    const persona = batch.cast[line.speaker];
    if (!persona) return;
    const quoteId = line.replyTo !== undefined ? batch.ids[line.replyTo] : undefined;
    if (epoch !== this.epoch) return;
    const message = await this.host.say(persona, line.text, quoteId);
    batch.ids[index] = message?.id;
  }

  private pickCast(pool: SimulatedPersona[]): SimulatedPersona[] {
    const size = Math.min(CAST_SIZE, pool.length);
    // Keep half of the previous cast so voices carry over, then bring in new ones.
    const kept = this.cast.filter((p) => pool.some((q) => q.id === p.id)).slice(0, Math.floor(size / 2));
    const fresh = pool.filter((p) => !kept.some((k) => k.id === p.id)).sort(() => Math.random() - 0.5);
    const cast = [...kept, ...fresh].slice(0, size);
    // Every room needs a loud one, or the swearing and roasting never starts.
    if (!cast.some(isRowdy)) {
      const loud = pool.find((p) => isRowdy(p) && !cast.includes(p));
      if (loud && cast.length) cast[cast.length - 1] = loud;
    }
    this.cast = cast.sort(() => Math.random() - 0.5);
    return this.cast;
  }

  private async refill(recent: ChatMessage[]) {
    this.generating = true;
    const epoch = this.epoch;
    try {
      const held = activeTopic(this.hold, Date.now());
      const cast = this.pickCast(await this.host.pool());
      if (cast.length < 2) return;
      // Lines still waiting to be posted are part of the story the next batch has to continue.
      const planned: SimulationMessageContext["messages"] = this.current
        ? this.current.lines.slice(this.current.next).map((l) => ({ alias: this.current!.cast[l.speaker]?.alias ?? "?", text: l.text }))
        : [];
      const lines = await generateScript({
        cast,
        messages: [
          ...recent.map((m) => ({ alias: m.alias, gender: m.gender, age: m.age, text: m.text, at: m.at, isReal: !this.host.isPersonaAlias(m.alias) })),
          ...planned,
        ],
        roomKey: this.host.roomKey,
        groupTitle: this.host.groupTitle,
        topicSeed: this.host.topicSeed,
        // The first batch about a new topic opens it; every later batch within 15 minutes keeps it going.
        focus: held?.topic,
        focusMode: held && held.batches > 0 ? "stay" : "open",
        stances: mixStances(cast.length),
        count: BATCH,
      });
      if (epoch !== this.epoch || lines.length === 0) return; // a person spoke meanwhile, or nothing usable
      if (held && this.hold?.startedAt === held.startedAt) this.hold = { ...this.hold, batches: this.hold.batches + 1 };
      this.upcoming = { cast, lines, ids: [], next: 0 };
    } catch (err) {
      console.error("Room script generation error:", err);
    } finally {
      this.generating = false;
    }
  }
}
