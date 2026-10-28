import { randomUUID } from "node:crypto";
import { EV, type ChatMessage } from "../../contracts";
import type { RedisClient } from "../../lib/redis";
import type { RoomsService } from "../chat/rooms.service";
import type { TypingStore } from "../chat/typing.store";
import type { AppServer } from "../../realtime/context";
import { getAllPersonas, getRandomPersona, isBotUserId, selectResponderPersona } from "./persona.service";
import { generateChatBubbles } from "./together.service";
import type { SimulatedPersona } from "./simulation.types";

export class GlobalChatSimulator {
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private recentMessages: Array<{ alias: string; text: string; id: string; gender?: string; isReal?: boolean }> = [];

  constructor(
    private io: AppServer,
    private redis: RedisClient,
    private rooms: RoomsService,
    private typing?: TypingStore
  ) {}

  public start() {
    if (this.timer) return;
    // Initial warmup
    void this.seedPersonasInRedis();
    // Schedule background chatter loop every 8 - 16 seconds
    this.scheduleNextChatter();
  }

  public stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextChatter() {
    const delay = Math.floor(7000 + Math.random() * 8000); // 7 to 15 seconds
    this.timer = setTimeout(async () => {
      try {
        await this.stepBackgroundChatter();
      } catch (err) {
        console.error("Global chat simulation step error:", err);
      } finally {
        this.scheduleNextChatter();
      }
    }, delay);
  }

  private async seedPersonasInRedis() {
    const personas = getAllPersonas();
    const multi = this.redis.multi();
    for (const p of personas) {
      multi.set(`global:alias:${p.id}`, p.alias, "EX", 86400 * 7);
      multi.set(`global:alias:rev:${p.alias}`, p.id, "EX", 86400 * 7);
    }
    await multi.exec().catch(() => {});
  }

  /**
   * Generates a step of background chat in the global room:
   * 1. Shows 2 to 3 persons typing at once.
   * 2. After a natural typing delay (1.5 - 3s), posts a message from one persona.
   */
  private async stepBackgroundChatter() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Pick 2 or 3 distinct personas for typing indicator
      const personas = getAllPersonas();
      const count = Math.random() < 0.7 ? 3 : 2; // 2 or 3 typists
      const shuffled = [...personas].sort(() => 0.5 - Math.random());
      const typists = shuffled.slice(0, count);

      // Emit typing indicator to global room
      const typistAliases = typists.map((t) => t.alias);
      this.io.to("r:global").emit(EV.roomTyping, {
        roomId: "global",
        typists: typistAliases,
      });

      // Natural typing delay before sending message (1.8s to 3.2s)
      const typingWaitMs = 1800 + Math.floor(Math.random() * 1400);
      await new Promise((resolve) => setTimeout(resolve, typingWaitMs));

      // Choose one of the typists to send the message
      const senderPersona = typists[0]!;
      await this.ensurePersonaAlias(senderPersona);

      // Generate message (either topic starter or reply to recent message)
      const shouldReply = this.recentMessages.length > 0 && Math.random() < 0.65;
      const quoted = shouldReply ? this.recentMessages[this.recentMessages.length - 1] : undefined;

      const bubbles = await generateChatBubbles({
        messages: this.recentMessages.map((m) => ({
          alias: m.alias,
          text: m.text,
          gender: m.gender as any,
          isReal: m.isReal,
        })),
        targetPersona: senderPersona,
        roomType: "global",
      });

      const textToSend = bubbles[0] || "kya chal raha hai dosto?";

      // Post to global room via roomsService
      const { message, duplicate } = await this.rooms.post(
        { userId: senderPersona.id, gender: senderPersona.gender, age: senderPersona.age },
        "global",
        randomUUID(),
        textToSend,
        quoted?.id
      );

      if (!duplicate) {
        this.io.to("r:global").emit(EV.roomMessage, message);
        this.trackRecentMessage(message, false);
      }

      // Remaining typists finish typing after brief moment
      setTimeout(() => {
        const remainingTypists = typistAliases.slice(1);
        this.io.to("r:global").emit(EV.roomTyping, {
          roomId: "global",
          typists: remainingTypists,
        });
        setTimeout(() => {
          this.io.to("r:global").emit(EV.roomTyping, {
            roomId: "global",
            typists: [],
          });
        }, 2000);
      }, 800);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Called whenever a real human user posts a message in the global chat.
   * Dispatches a natural persona reply in Hinglish.
   * If user is male: 70% female attention, 30% male attention, flirty and engaging!
   */
  public async handleRealUserMessage(realUser: { userId: string; gender: any; age: number }, message: ChatMessage) {
    if (isBotUserId(realUser.userId)) return;

    this.trackRecentMessage(message, true);

    // Pick 1 or 2 personas to respond to the real user
    const responder = selectResponderPersona(realUser.gender, [message.alias]);
    await this.ensurePersonaAlias(responder);

    // Also pick a secondary persona typing alongside to maintain active room feel
    const secondary = getRandomPersona();
    const typistAliases = [responder.alias, secondary.alias];

    // After 1 - 2.5s, show typing indicator
    setTimeout(async () => {
      this.io.to("r:global").emit(EV.roomTyping, {
        roomId: "global",
        typists: typistAliases,
      });

      // Typing duration based on realistic human typing
      const typingDuration = 2200 + Math.floor(Math.random() * 2000);
      await new Promise((r) => setTimeout(r, typingDuration));

      try {
        const bubbles = await generateChatBubbles({
          messages: [
            ...this.recentMessages.map((m) => ({
              alias: m.alias,
              text: m.text,
              gender: m.gender as any,
              isReal: m.isReal,
            })),
            {
              alias: message.alias,
              gender: message.gender,
              age: message.age,
              text: message.text,
              isReal: true,
            },
          ],
          targetPersona: responder,
          realUserGender: realUser.gender,
          roomType: "global",
        });

        // Send bubble(s)
        for (let i = 0; i < Math.min(bubbles.length, 2); i++) {
          const text = bubbles[i]!;
          const { message: replyMsg, duplicate } = await this.rooms.post(
            { userId: responder.id, gender: responder.gender, age: responder.age },
            "global",
            randomUUID(),
            text,
            i === 0 ? message.id : undefined // Quote on first bubble
          );

          if (!duplicate) {
            this.io.to("r:global").emit(EV.roomMessage, replyMsg);
            this.trackRecentMessage(replyMsg, false);
          }

          if (i < bubbles.length - 1) {
            // Brief delay between bubbles
            await new Promise((r) => setTimeout(r, 1400 + Math.random() * 1000));
          }
        }
      } catch (err) {
        console.error("Error generating global reply for real user:", err);
      } finally {
        this.io.to("r:global").emit(EV.roomTyping, {
          roomId: "global",
          typists: [],
        });
      }
    }, 1200 + Math.random() * 1800);
  }

  private async ensurePersonaAlias(p: SimulatedPersona) {
    await this.redis.set(`global:alias:${p.id}`, p.alias, "EX", 86400 * 7);
    await this.redis.set(`global:alias:rev:${p.alias}`, p.id, "EX", 86400 * 7);
  }

  private trackRecentMessage(m: ChatMessage, isReal: boolean) {
    this.recentMessages.push({
      id: m.id,
      alias: m.alias,
      text: m.text,
      gender: m.gender,
      isReal,
    });
    if (this.recentMessages.length > 25) {
      this.recentMessages.shift();
    }
  }
}
