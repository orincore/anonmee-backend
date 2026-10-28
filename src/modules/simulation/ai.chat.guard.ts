import { closeAfterMs, IDLE_GOODBYES, PINGS, pickLine, pingAfterMs } from "./chat.idle";
import { freshHostility, nextHostility, type HostilityState } from "./chat.hostility";

/** What the guard needs from the chat it watches. Kept small so the timing and decisions can be tested on their own. */
export interface GuardActions {
  isActive(chatId: string): Promise<boolean>;
  /** The AI user types and sends this message. */
  say(chatId: string, text: string): Promise<void>;
  /** Close the chat from the AI user's side. */
  end(chatId: string, reason: "idle"): Promise<void>;
}

interface IdleClock {
  timer: NodeJS.Timeout;
}

/**
 * Watches one AI 1:1 chat at a time per chat id: if the person goes quiet the AI user asks once whether they
 * are there and then closes the chat; and it keeps the score of how rudely the person is behaving.
 */
export class AiChatGuard {
  private clocks = new Map<string, IdleClock>();
  private hostility = new Map<string, HostilityState>();

  constructor(private actions: GuardActions, private rng: () => number = Math.random) {}

  /** The person is expected to answer now: start the silence clock over. */
  public arm(chatId: string) {
    this.stopClock(chatId);
    const timer = setTimeout(() => void this.ping(chatId), pingAfterMs(this.rng));
    timer.unref();
    this.clocks.set(chatId, { timer });
  }

  /** The person is typing: they are here, so a running silence clock starts over. */
  public touch(chatId: string) {
    if (this.clocks.has(chatId)) this.arm(chatId);
  }

  /** Stop watching for silence (the person just spoke, or the chat is over). */
  public disarm(chatId: string) {
    this.stopClock(chatId);
  }

  /** The chat is over for good: forget everything about it. */
  public forget(chatId: string) {
    this.stopClock(chatId);
    this.hostility.delete(chatId);
  }

  /** Scores a message from the person. Also counts as activity, so the silence clock stops. */
  public observe(chatId: string, text: string, tolerance: number) {
    this.stopClock(chatId);
    const verdict = nextHostility(this.hostility.get(chatId) ?? freshHostility(), text, tolerance);
    this.hostility.set(chatId, verdict.state);
    return { skip: verdict.skip, warn: verdict.warn, reason: verdict.reason, warnings: verdict.state.warnings };
  }

  private stopClock(chatId: string) {
    const c = this.clocks.get(chatId);
    if (c) clearTimeout(c.timer);
    this.clocks.delete(chatId);
  }

  private async ping(chatId: string) {
    this.clocks.delete(chatId);
    try {
      if (!(await this.actions.isActive(chatId))) return this.forget(chatId);
      await this.actions.say(chatId, pickLine(PINGS, this.rng));
      const timer = setTimeout(() => void this.close(chatId), closeAfterMs(this.rng));
      timer.unref();
      this.clocks.set(chatId, { timer });
    } catch (err) {
      console.error("AI chat ping failed:", err);
    }
  }

  private async close(chatId: string) {
    this.clocks.delete(chatId);
    try {
      if (!(await this.actions.isActive(chatId))) return this.forget(chatId);
      await this.actions.say(chatId, pickLine(IDLE_GOODBYES, this.rng));
      await this.actions.end(chatId, "idle");
    } catch (err) {
      console.error("AI chat close failed:", err);
    } finally {
      this.forget(chatId);
    }
  }
}
