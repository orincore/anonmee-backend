import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { EV, type ChatMessage } from "../../contracts";
import type { Db } from "../../db/client";
import { groupMembers, groups, users } from "../../db/schema";
import type { RedisClient } from "../../lib/redis";
import type { RoomsService } from "../chat/rooms.service";
import type { AppServer } from "../../realtime/context";
import { getAllPersonas, getRandomPersona, isBotUserId, seedPersonasInDb, selectResponderPersona, SYSTEM_BOT_USER_ID } from "./persona.service";
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
  private isProcessing = false;

  constructor(
    private db: Db,
    private redis: RedisClient,
    private rooms: RoomsService,
    private io: AppServer
  ) {}

  public start() {
    if (this.timer) return;
    void this.ensureSystemBotUser();
    void seedPersonasInDb(this.db);
    void this.maintainSimulatedGroups();

    // Check and post messages in groups every 25 - 45 seconds
    this.scheduleNextGroupChat();
  }

  public stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextGroupChat() {
    const delay = Math.floor(25000 + Math.random() * 20000); // 25 to 45 seconds
    this.timer = setTimeout(async () => {
      try {
        await this.stepGroupActivity();
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

  private async createSimulatedGroup(tpl: (typeof GROUP_TEMPLATES)[0]) {
    try {
      const persona = getRandomPersona();
      const groupId = randomUUID();
      const members = [persona, getRandomPersona(), getRandomPersona()];

      await this.db.transaction(async (tx) => {
        await tx.insert(groups).values({
          id: groupId,
          ownerId: SYSTEM_BOT_USER_ID,
          title: tpl.title,
          topic: tpl.topic,
          tags: [tpl.topic],
          description: tpl.description,
          memberCount: 3 + Math.floor(Math.random() * 8),
        });

        // Add 2-3 persona members
        for (const m of members) {
          await tx.insert(groupMembers).values({
            groupId,
            userId: m.id,
            alias: m.alias,
          }).onConflictDoNothing();
          await this.redis.set(`member:${groupId}:${m.id}`, m.alias, "EX", 86400 * 7);
        }
      });

      // Seed 2-3 initial chat messages
      const seedSender = members[0]!;
      await this.rooms.post(
        { userId: seedSender.id, gender: seedSender.gender, age: seedSender.age },
        groupId,
        randomUUID(),
        `Hey everyone! Welcome to ${tpl.title} 🙌`
      );

      const replySender = members[1]!;
      await this.rooms.post(
        { userId: replySender.id, gender: replySender.gender, age: replySender.age },
        groupId,
        randomUUID(),
        "Hie! Koi hai yaha abhi live?"
      );
    } catch (e) {
      console.error("Failed to create simulated group:", e);
    }
  }

  /**
   * Periodically posts a message to one of the active groups so they feel active.
   */
  private async stepGroupActivity() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const activeGroups = await this.db
        .select()
        .from(groups)
        .where(and(eq(groups.ownerId, SYSTEM_BOT_USER_ID), isNull(groups.closedAt)))
        .limit(6);

      if (activeGroups.length === 0) return;

      const targetGroup = activeGroups[Math.floor(Math.random() * activeGroups.length)]!;
      const persona = getRandomPersona();

      // Show typing in that group room
      this.io.to(`r:${targetGroup.id}`).emit(EV.roomTyping, {
        roomId: targetGroup.id,
        typists: [persona.alias],
      });

      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1500));

      const bubbles = await generateChatBubbles({
        messages: [{ alias: persona.alias, text: "hey", isReal: false }],
        targetPersona: persona,
        roomType: "group",
        groupTopic: targetGroup.topic,
      });

      await this.redis.set(`member:${targetGroup.id}:${persona.id}`, persona.alias, "EX", 86400 * 7);
      const text = bubbles[0] || "aur batao dosto kya plan hai?";
      const { message, duplicate } = await this.rooms.post(
        { userId: persona.id, gender: persona.gender, age: persona.age },
        targetGroup.id,
        randomUUID(),
        text
      );

      if (!duplicate) {
        this.io.to(`r:${targetGroup.id}`).emit(EV.roomMessage, message);
      }

      this.io.to(`r:${targetGroup.id}`).emit(EV.roomTyping, {
        roomId: targetGroup.id,
        typists: [],
      });
    } catch (err) {
      console.error("Error in group simulation step:", err);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Called when a real user chats in any group room.
   */
  public async handleRealUserGroupMessage(realUser: { userId: string; gender: any; age: number }, message: ChatMessage) {
    if (isBotUserId(realUser.userId) || message.roomId === "global") return;

    const responder = selectResponderPersona(realUser.gender, [message.alias]);

    setTimeout(async () => {
      this.io.to(`r:${message.roomId}`).emit(EV.roomTyping, {
        roomId: message.roomId,
        typists: [responder.alias],
      });

      const typingDuration = 2200 + Math.floor(Math.random() * 1800);
      await new Promise((r) => setTimeout(r, typingDuration));

      try {
        const bubbles = await generateChatBubbles({
          messages: [
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
          roomType: "group",
        });

        await this.redis.set(`member:${message.roomId}:${responder.id}`, responder.alias, "EX", 86400 * 7);
        const replyText = bubbles[0] || "sahi baat hai haha";
        const { message: replyMsg, duplicate } = await this.rooms.post(
          { userId: responder.id, gender: responder.gender, age: responder.age },
          message.roomId,
          randomUUID(),
          replyText,
          message.id
        );

        if (!duplicate) {
          this.io.to(`r:${message.roomId}`).emit(EV.roomMessage, replyMsg);
        }
      } catch (err) {
        console.error("Error replying to real user in group:", err);
      } finally {
        this.io.to(`r:${message.roomId}`).emit(EV.roomTyping, {
          roomId: message.roomId,
          typists: [],
        });
      }
    }, 1500 + Math.random() * 2000);
  }
}
