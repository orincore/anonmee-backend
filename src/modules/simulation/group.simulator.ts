import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { EV, type ChatMessage } from "../../contracts";
import type { Db } from "../../db/client";
import { groupMembers, groups, users } from "../../db/schema";
import type { RedisClient } from "../../lib/redis";
import type { RoomsService } from "../chat/rooms.service";
import type { AppServer } from "../../realtime/context";
import { RoomScript, type RoomScriptHost } from "./script.runner";
import type { SimulatedPersona, SimulationMessageContext } from "./simulation.types";
import { getAllPersonas, getPersonaById, isBotUserId, seedPersonasInDb, SYSTEM_BOT_USER_ID } from "./persona.service";
import type { BotGate } from "./bots.gate";
import { inCrisis, looksUnderage } from "./chat.safety";
import { noDashes } from "./chat.texting";
import { respondAsCrowd } from "./crowd.responder";
import { generateChatBubbles } from "./together.service";

const GROUP_TEMPLATES = [
  { title: "Late Night Talks ✨", topic: "dating", description: "Bore ho rahe ho? Aa jao baatein karte hain, no judgments." },
  { title: "Delhi NCR Singles", topic: "casual_chat", description: "Gurgaon, Noida, Delhi peeps vibe check! Weekend plans?" },
  { title: "Bumble Se Tang Aaye Log 😭", topic: "flirting", description: "Tired of dry texts? Real anonymous conversations only." },
  { title: "Confessions & Secrets 🤫", topic: "open_minded", description: "Share what you cannot tell your friends. 100% anonymous." },
  { title: "Chai Pe Charcha ☕", topic: "casual_chat", description: "Chai lovers, monsoon vibes, and late night discussions." },
  { title: "Dil Ki Baatein ❤️", topic: "online_romance", description: "Kuch unkahi baatein, romance, heartbreak, and sweet vibes." },
  { title: "Bangalore Night Owls 🦉", topic: "friendship", description: "Can't sleep? Coding, gaming, or just random midnight chats." },
  { title: "Bollywood & Chill 🍿", topic: "casual_chat", description: "Movie buffs, drama, songs, and gossip." },
];

export class GroupSimulator {
  private timer: NodeJS.Timeout | null = null;
  private scripts = new Map<string, RoomScript>();
  private crowdEpochs = new Map<string, number>();
  private ticks = 0;

  constructor(
    private db: Db,
    private redis: RedisClient,
    private rooms: RoomsService,
    private io: AppServer,
    private gate: BotGate,
  ) {}

  public start() {
    if (this.timer) return;
    // Personas must exist as users before they can become group members.
    void (async () => {
      await this.ensureSystemBotUser();
      await seedPersonasInDb(this.db);
      await this.maintainSimulatedGroups();
      await this.syncScripts();
    })();

    // Check and post messages in groups every 25 - 45 seconds
    this.scheduleNextGroupChat();
  }

  public stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const script of this.scripts.values()) script.stop();
    this.scripts.clear();
  }

  private scheduleNextGroupChat() {
    const delay = Math.floor(30000 + Math.random() * 15000); // 30 to 45 seconds
    this.timer = setTimeout(async () => {
      try {
        if (++this.ticks % 20 === 0) await this.maintainSimulatedGroups(); // roughly every 10 minutes
        await this.syncScripts();
      } catch (err) {
        console.error("Group simulation error:", err);
      } finally {
        this.scheduleNextGroupChat();
      }
    }, delay);
  }

  private async ensureSystemBotUser() {
    try {
      await this.db.execute(sql`
        INSERT INTO users (id, email, password_hash, username, gender, date_of_birth, created_at)
        VALUES (
          ${SYSTEM_BOT_USER_ID}::uuid,
          'system.bot@anonmee.in',
          'dummy_hash_for_sim_system_bot',
          'anonmeebot',
          'female'::gender,
          '2002-05-15'::date,
          now()
        )
        ON CONFLICT (id) DO NOTHING
      `);
    } catch (e) {
      // Table might have constraint or already exists
    }
  }

  /**
   * Ensures 4 - 6 active simulated groups exist in the database.
   * Periodically rotates (closes oldest simulated group and adds a fresh one).
   */
  public async maintainSimulatedGroups() {
    try {
      await this.ensureSystemBotUser();

      const activeSimGroups = await this.db
        .select()
        .from(groups)
        .where(and(eq(groups.ownerId, SYSTEM_BOT_USER_ID), isNull(groups.closedAt)))
        .orderBy(desc(groups.createdAt));

      // If fewer than 4 simulated groups exist, create some
      if (activeSimGroups.length < 4) {
        const needed = 5 - activeSimGroups.length;
        const availableTemplates = GROUP_TEMPLATES.filter(
          (t) => !activeSimGroups.some((g) => g.title === t.title)
        );

        for (let i = 0; i < Math.min(needed, availableTemplates.length); i++) {
          const tpl = availableTemplates[i]!;
          await this.createSimulatedGroup(tpl);
        }
      } else if (activeSimGroups.length > 7) {
        // Close oldest to rotate fresh ones
        const oldest = activeSimGroups[activeSimGroups.length - 1];
        if (oldest) {
          await this.db
            .update(groups)
            .set({ closedAt: new Date() })
            .where(eq(groups.id, oldest.id));
        }
      }
    } catch (err) {
      console.error("Error maintaining simulated groups:", err);
    }
  }

  private personaAliases = new Set(getAllPersonas().map((p) => p.alias));

  private toContext(messages: ChatMessage[]): SimulationMessageContext["messages"] {
    return messages.map((m) => ({ alias: m.alias, gender: m.gender, age: m.age, text: m.text, at: m.at, isReal: !this.personaAliases.has(m.alias) }));
  }

  /** Adds a persona to a group (idempotent) and primes the alias cache the chat service reads. */
  private async ensureMember(groupId: string, persona: SimulatedPersona) {
    await this.db.insert(groupMembers).values({ groupId, userId: persona.id, alias: persona.alias }).onConflictDoNothing();
    await this.redis.set(`member:${groupId}:${persona.id}`, persona.alias, "EX", 86400 * 7);
  }

  /** The personas that belong to this group. A group keeps the same few voices, like a real one. */
  private async castOf(groupId: string): Promise<SimulatedPersona[]> {
    const ids = getAllPersonas().map((p) => p.id);
    const rows = await this.db.select({ id: groupMembers.userId }).from(groupMembers).where(and(eq(groupMembers.groupId, groupId), inArray(groupMembers.userId, ids)));
    return rows.map((r) => getPersonaById(r.id)).filter((p): p is SimulatedPersona => !!p);
  }

  private async say(groupId: string, persona: SimulatedPersona, text: string, replyToId?: string): Promise<ChatMessage | null> {
    await this.ensureMember(groupId, persona);
    this.io.to(`r:${groupId}`).emit(EV.roomTyping, { roomId: groupId, typists: [persona.alias] });
    await new Promise((r) => setTimeout(r, Math.min(Math.max(text.length * 65, 1200), 3600)));
    try {
      const { message, duplicate } = await this.rooms.post({ userId: persona.id, gender: persona.gender, age: persona.age }, groupId, randomUUID(), noDashes(text), replyToId);
      if (!duplicate) {
        this.io.to(`r:${groupId}`).emit(EV.roomMessage, message);
        this.gate.notePosted(`r:${groupId}`); // counts towards the backlog if nobody is looking
      }
      return duplicate ? null : message;
    } finally {
      this.io.to(`r:${groupId}`).emit(EV.roomTyping, { roomId: groupId, typists: [] });
    }
  }

  private async createSimulatedGroup(tpl: (typeof GROUP_TEMPLATES)[0]) {
    try {
      const groupId = randomUUID();
      const cast = [...getAllPersonas()].sort(() => Math.random() - 0.5).slice(0, 4);

      await this.db.insert(groups).values({
        id: groupId,
        ownerId: SYSTEM_BOT_USER_ID,
        title: tpl.title,
        topic: tpl.topic,
        tags: [tpl.topic],
        description: tpl.description,
        memberCount: 3 + Math.floor(Math.random() * 8),
      });
      for (const persona of cast) await this.ensureMember(groupId, persona);

      // One opener from one member, written for this group. Only while someone is online: it costs a model call.
      if (!(await this.gate.open())) return;
      const opener = cast[0]!;
      const bubbles = await generateChatBubbles({
        messages: [],
        targetPersona: opener,
        roomType: "group",
        roomKey: groupId,
        groupTitle: tpl.title,
        groupTopic: tpl.topic,
        topicSeed: tpl.description,
      });
      if (bubbles[0]) await this.say(groupId, opener, bubbles[0]);
    } catch (e) {
      console.error("Failed to create simulated group:", e);
    }
  }

  private hostFor(g: { id: string; title: string; description: string | null }): RoomScriptHost {
    return {
      roomKey: g.id,
      groupTitle: g.title,
      topicSeed: g.description ?? undefined,
      pool: () => this.castOf(g.id),
      history: () => this.rooms.recentMessages(g.id, 20),
      say: (persona, text, replyToId) => this.say(g.id, persona, text, replyToId),
      isPersonaAlias: (alias) => this.personaAliases.has(alias),
      topic: () => this.scripts.get(g.id)?.currentTopic() ?? null,
      hasAudience: () => this.gate.hasAudience(`r:${g.id}`),
      onWake: (cb) => {
        this.gate.on("wake", cb);
        return () => void this.gate.off("wake", cb);
      },
    };
  }

  /** One script per open simulated group; closed groups stop. Cheap, so it is safe to run often. */
  private async syncScripts() {
    const open = await this.db
      .select({ id: groups.id, title: groups.title, topic: groups.topic, description: groups.description })
      .from(groups)
      .where(and(eq(groups.ownerId, SYSTEM_BOT_USER_ID), isNull(groups.closedAt)))
      .limit(8);
    const openIds = new Set(open.map((g) => g.id));
    for (const [id, script] of this.scripts) {
      if (!openIds.has(id)) {
        script.stop();
        this.scripts.delete(id);
      }
    }
    for (const g of open) {
      if (this.scripts.has(g.id)) continue;
      const script = new RoomScript(this.hostFor(g), { minGapMs: 6000, maxGapMs: 20000, humanGraceMs: 20_000 });
      this.scripts.set(g.id, script);
      script.start();
    }
  }

  /** Called when a real user chats in a group: several members of that group's cast answer with different attitudes. */
  public async handleRealUserGroupMessage(realUser: { userId: string; gender: any; age: number }, message: ChatMessage) {
    if (isBotUserId(realUser.userId) || message.roomId === "global") return;
    if (looksUnderage(message.text) || inCrisis(message.text)) return; // never engage with someone who may be under 18 or in crisis

    const script = this.scripts.get(message.roomId);
    script?.noteHuman(message.text); // their topic is held for 15 minutes; planned chatter is dropped, this person is answered first
    const epoch = (this.crowdEpochs.get(message.roomId) ?? 0) + 1;
    this.crowdEpochs.set(message.roomId, epoch);
    try {
      const [group] = await this.db.select({ id: groups.id, title: groups.title, description: groups.description }).from(groups).where(eq(groups.id, message.roomId)).limit(1);
      if (!group || (await this.castOf(group.id)).length === 0) return; // not one of our groups
      await respondAsCrowd({ host: this.hostFor(group), roomType: "group", message, userGender: realUser.gender, isCurrent: () => this.crowdEpochs.get(message.roomId) === epoch });
    } catch (err) {
      console.error("Error replying to real user in group:", err);
    }
  }
}
