import { settleGapMs } from "./chat.timing";

/** The client sends a typing signal at most every 2 seconds while the person types, so a bit longer than that means they stopped. */
export const TYPING_ACTIVE_MS = 3500;
const POLL_MS = 400;
const MAX_CHATS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Decides when an AI user may answer: not while the person is still typing, and not until a short quiet gap
 * has shown they are not about to send another message. Pure timing, no I/O, unit tested.
 */
export class ReplyPacer {
  private messages = new Map<string, { at: number; text: string }>();
  private typing = new Map<string, number>();

  constructor(private rng: () => number = Math.random) {}

  public noteMessage(chatId: string, text: string) {
    this.remember(this.messages, chatId, { at: Date.now(), text });
  }

  public noteTyping(chatId: string) {
    this.remember(this.typing, chatId, Date.now());
  }

  public isTyping(chatId: string): boolean {
    return Date.now() - (this.typing.get(chatId) ?? 0) < TYPING_ACTIVE_MS;
  }

  public lastText(chatId: string): string {
    return this.messages.get(chatId)?.text ?? "";
  }

  public lastMessageAt(chatId: string): number {
    return this.messages.get(chatId)?.at ?? 0;
  }

  /** Did the person send something after `since`? */
  public newerMessageSince(chatId: string, since: number): boolean {
    return this.lastMessageAt(chatId) > since;
  }

  /**
   * Resolves once the person has stopped typing and been quiet for a short, slightly different gap each time.
   * Typing or a new message starts the wait over. Gives up after `maxMs` so a very long typist still gets an answer.
   */
  public async settle(chatId: string, maxMs = 30_000): Promise<void> {
    const started = Date.now();
    let decidedFor = -1;
    let gap = 0;
    for (;;) {
      const now = Date.now();
      const last = this.messages.get(chatId);
      const lastActivity = Math.max(last?.at ?? 0, this.typing.get(chatId) ?? 0);
      // Decide the gap once per message ("hi" waits longer than a finished question), not on every poll.
      if (last?.at !== decidedFor) {
        decidedFor = last?.at ?? 0;
        gap = settleGapMs(last?.text ?? "", this.rng);
      }
      if (!this.isTyping(chatId) && now - lastActivity >= gap) return;
      if (now - started >= maxMs) return;
      await sleep(POLL_MS);
    }
  }

  public forget(chatId: string) {
    this.messages.delete(chatId);
    this.typing.delete(chatId);
  }

  // A chat that ended some other way never calls forget; keep the maps from growing without bound.
  private remember<T>(map: Map<string, T>, key: string, value: T) {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_CHATS) map.delete(map.keys().next().value!);
  }
}
