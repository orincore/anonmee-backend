import { randomUUID } from "node:crypto";
import { EV, type ChatMessage } from "../../contracts";
import type { RedisClient } from "../../lib/redis";
import type { RoomsService } from "../chat/rooms.service";
import type { TypingStore } from "../chat/typing.store";
import type { AppServer } from "../../realtime/context";
import { getAllPersonas, isBotUserId } from "./persona.service";
import type { BotGate } from "./bots.gate";
import { noDashes } from "./chat.texting";
import { respondAsCrowd } from "./crowd.responder";
import { RoomScript, type RoomScriptHost } from "./script.runner";
import { inCrisis, looksUnderage } from "./chat.safety";
import type { SimulatedPersona, SimulationMessageContext } from "./simulation.types";

const HUMAN_GRACE_MS = 20_000; // let a person's message be answered by the reply path first
const HISTORY = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Roughly how long a person takes to type `text`. */
const typingTime = (text: string) => Math.min(Math.max(text.length * 65, 1200), 3600);

export class GlobalChatSimulator {
  private personaAliases = new Set(getAllPersonas().map((p) => p.alias));

  constructor(
    private io: AppServer,
    private redis: RedisClient,
    private rooms: RoomsService,
    private gate: BotGate,
    private typing?: TypingStore
  ) {}

  private crowdEpoch = 0;

  private host: RoomScriptHost = {
    roomKey: "global",
    pool: async () => getAllPersonas(),
    history: () => this.rooms.recentMessages("global", HISTORY),
    say: (persona, text, replyToId) => this.say(persona, text, replyToId),
    isPersonaAlias: (alias) => this.personaAliases.has(alias),
    topic: () => this.script.currentTopic(),
    hasAudience: () => this.gate.hasAudience("r:global"),
    onWake: (cb) => {
      this.gate.on("wake", cb);
      return () => void this.gate.off("wake", cb);
    },
  };

  private script = new RoomScript(this.host, { minGapMs: 3500, maxGapMs: 11000, humanGraceMs: HUMAN_GRACE_MS });

  public start() {
    void this.seedPersonasInRedis();
    this.script.start();
  }

  public stop() {
    this.script.stop();
  }

  private async seedPersonasInRedis() {
    const multi = this.redis.multi();
    for (const p of getAllPersonas()) {
      multi.set(`global:alias:${p.id}`, p.alias, "EX", 86400 * 7);
      multi.set(`global:alias:rev:${p.alias}`, p.id, "EX", 86400 * 7);
    }
    await multi.exec().catch(() => {});
  }

  private toContext(messages: ChatMessage[]): SimulationMessageContext["messages"] {
    return messages.map((m) => ({ alias: m.alias, gender: m.gender, age: m.age, text: m.text, at: m.at, isReal: !this.personaAliases.has(m.alias) }));
  }

  /** Posts one line as `persona`: typing indicator for as long as it takes to type it, then the message. */
  private async say(persona: SimulatedPersona, text: string, replyToId?: string): Promise<ChatMessage | null> {
    await this.ensurePersonaAlias(persona);
    this.io.to("r:global").emit(EV.roomTyping, { roomId: "global", typists: [persona.alias] });
    await sleep(typingTime(text));
    try {
      const { message, duplicate } = await this.rooms.post({ userId: persona.id, gender: persona.gender, age: persona.age }, "global", randomUUID(), noDashes(text), replyToId);
      if (!duplicate) {
        this.io.to("r:global").emit(EV.roomMessage, message);
        this.gate.notePosted("r:global"); // counts towards the backlog if nobody is looking
      }
      return duplicate ? null : message;
    } finally {
      this.io.to("r:global").emit(EV.roomTyping, { roomId: "global", typists: [] });
    }
  }

  /**
   * Called whenever a real person posts in the global chat. Several personas answer with different attitudes,
   * and the planned chatter is pointed at what the person talked about.
   */
  public async handleRealUserMessage(realUser: { userId: string; gender: any; age: number }, message: ChatMessage) {
    if (isBotUserId(realUser.userId)) return;
    if (looksUnderage(message.text) || inCrisis(message.text)) return; // never engage with someone who may be under 18 or in crisis

    this.script.noteHuman(message.text); // their topic is held for 15 minutes; the planned chatter is dropped, this person is answered first
    const epoch = ++this.crowdEpoch;
    try {
      await respondAsCrowd({ host: this.host, roomType: "global", message, userGender: realUser.gender, isCurrent: () => epoch === this.crowdEpoch });
    } catch (err) {
      console.error("Error generating global replies for real user:", err);
    }
  }

  private async ensurePersonaAlias(p: SimulatedPersona) {
    await this.redis.set(`global:alias:${p.id}`, p.alias, "EX", 86400 * 7);
    await this.redis.set(`global:alias:rev:${p.alias}`, p.id, "EX", 86400 * 7);
  }
}
