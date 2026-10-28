import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Gender } from "../../contracts";
import type { Db } from "../../db/client";
import { randomAlias } from "../../lib/alias";
import type { SimulatedPersona } from "./simulation.types";

export const BOT_UUID_PREFIX = "00000000-0000-4000-a001-";
export const SYSTEM_BOT_USER_ID = "00000000-0000-0000-0000-000000000001";

const FEMALE_PERSONAS: Array<Omit<SimulatedPersona, "id">> = [
  { alias: "Velvet Fox 23", gender: "female", age: 22, vibe: "flirty", interests: ["music", "late_night", "movies"] },
  { alias: "Sweet Sparrow 19", gender: "female", age: 21, vibe: "playful", interests: ["travel", "coffee", "memes"] },
  { alias: "Misty Panda 47", gender: "female", age: 23, vibe: "bubbly", interests: ["bollywood", "chats", "vibing"] },
  { alias: "Glow Cheetah 81", gender: "female", age: 20, vibe: "witty", interests: ["coding", "gaming", "night_owl"] },
  { alias: "Sunny Koala 35", gender: "female", age: 24, vibe: "chill", interests: ["books", "food", "photography"] },
  { alias: "Blush Rabbit 12", gender: "female", age: 22, vibe: "flirty", interests: ["fashion", "music", "confessions"] },
  { alias: "Cosmic Otter 64", gender: "female", age: 25, vibe: "night_owl", interests: ["astronomy", "deep_talks", "chai"] },
  { alias: "Pink Dolphin 28", gender: "female", age: 21, vibe: "playful", interests: ["dance", "delhi", "vibes"] },
  { alias: "Wild Blossom 53", gender: "female", age: 23, vibe: "witty", interests: ["movies", "comedy", "romance"] },
  { alias: "Dreamy Gazelle 90", gender: "female", age: 24, vibe: "chill", interests: ["art", "design", "music"] },
  { alias: "Silver Fawn 16", gender: "female", age: 22, vibe: "flirty", interests: ["dating", "confessions", "night_talks"] },
  { alias: "Amber Tiger 38", gender: "female", age: 26, vibe: "bubbly", interests: ["travel", "gym", "food"] },
];

const MALE_PERSONAS: Array<Omit<SimulatedPersona, "id">> = [
  { alias: "Neon Falcon 72", gender: "male", age: 23, vibe: "witty", interests: ["gaming", "cricket", "tech"] },
  { alias: "Bold Badger 45", gender: "male", age: 24, vibe: "chill", interests: ["football", "gym", "music"] },
  { alias: "Quiet Wolf 18", gender: "male", age: 22, vibe: "night_owl", interests: ["coding", "anime", "chai"] },
  { alias: "Cool Hawk 88", gender: "male", age: 25, vibe: "playful", interests: ["startups", "memes", "movies"] },
  { alias: "Swift Lynx 31", gender: "male", age: 23, vibe: "chill", interests: ["fitness", "roadtrips", "guitar"] },
  { alias: "Shadow Bear 59", gender: "male", age: 24, vibe: "witty", interests: ["philosophy", "night_talks", "humor"] },
  { alias: "Brisk Panther 14", gender: "male", age: 22, vibe: "playful", interests: ["sports", "gaming", "delhi"] },
  { alias: "Calm Raven 96", gender: "male", age: 26, vibe: "night_owl", interests: ["books", "indie_music", "coffee"] },
];

// Persistent pool mapping id -> SimulatedPersona
const personaMap = new Map<string, SimulatedPersona>();

function initPersonas() {
  FEMALE_PERSONAS.forEach((p, idx) => {
    const id = `${BOT_UUID_PREFIX}0000000001${String(idx + 1).padStart(2, "0")}`;
    personaMap.set(id, { id, ...p });
  });
  MALE_PERSONAS.forEach((p, idx) => {
    const id = `${BOT_UUID_PREFIX}0000000002${String(idx + 1).padStart(2, "0")}`;
    personaMap.set(id, { id, ...p });
  });
}

initPersonas();

export function getAllPersonas(): SimulatedPersona[] {
  return Array.from(personaMap.values());
}

export function getPersonaById(id: string): SimulatedPersona | undefined {
  return personaMap.get(id);
}

/**
 * Returns a random persona from the pool.
 * Respects 60% female / 40% male ratio overall by default.
 */
export function getRandomPersona(preferredGender?: "female" | "male"): SimulatedPersona {
  const all = getAllPersonas();
  if (preferredGender) {
    const filtered = all.filter((p) => p.gender === preferredGender);
    if (filtered.length > 0) {
      return filtered[Math.floor(Math.random() * filtered.length)]!;
    }
  }

  // 60% female / 40% male general ratio
  const isFemale = Math.random() < 0.60;
  const targetGender = isFemale ? "female" : "male";
  const pool = all.filter((p) => p.gender === targetGender);
  return pool[Math.floor(Math.random() * pool.length)] ?? all[0]!;
}

/**
 * Selects a responder persona for a real user interaction:
 * - If real user is male: 70% female attention, 30% male attention.
 * - If real user is female: 60% male attention, 40% female attention.
 * - Avoids using the user's own id/alias.
 */
export function selectResponderPersona(realUserGender?: Gender, excludeAliases: string[] = []): SimulatedPersona {
  let targetGender: "female" | "male";

  if (realUserGender === "male") {
    // 70% female attention, 30% male attention
    targetGender = Math.random() < 0.70 ? "female" : "male";
  } else if (realUserGender === "female") {
    targetGender = Math.random() < 0.60 ? "male" : "female";
  } else {
    // Other/unspecified: 60% female, 40% male
    targetGender = Math.random() < 0.60 ? "female" : "male";
  }

  const candidates = getAllPersonas().filter(
    (p) => p.gender === targetGender && !excludeAliases.includes(p.alias)
  );

  if (candidates.length > 0) {
    return candidates[Math.floor(Math.random() * candidates.length)]!;
  }

  return getRandomPersona(targetGender);
}

/**
 * Creates a dynamic persona with fresh alias for 1-on-1 match if needed.
 */
export function createDynamicPersona(gender: "female" | "male", minAge = 20, maxAge = 25): SimulatedPersona {
  const age = Math.min(Math.max(Math.floor(minAge + Math.random() * (maxAge - minAge + 1)), 18), 35);
  const rawUuid = randomUUID();
  const id = `${BOT_UUID_PREFIX}${rawUuid.slice(BOT_UUID_PREFIX.length)}`;
  const alias = randomAlias();
  const vibes: SimulatedPersona["vibe"][] = ["flirty", "playful", "bubbly", "chill", "witty", "night_owl"];
  const vibe = vibes[Math.floor(Math.random() * vibes.length)]!;

  const persona: SimulatedPersona = {
    id,
    alias,
    gender,
    age,
    interests: ["music", "movies", "late_night", "chats", "confessions"],
    vibe,
  };

  personaMap.set(id, persona);
  return persona;
}

export function isBotUserId(userId: string): boolean {
  return (
    userId.startsWith(BOT_UUID_PREFIX) ||
    userId.startsWith("bot:") ||
    userId.startsWith("sim:") ||
    userId === SYSTEM_BOT_USER_ID
  );
}

/**
 * Seeds all persona accounts in the users table so foreign key constraints in room_messages and group_members succeed.
 */
export async function seedPersonasInDb(db: Db) {
  const personas = getAllPersonas();
  for (const p of personas) {
    try {
      const email = `bot.${p.alias.toLowerCase().replace(/[^a-z0-9]/g, "")}@anonmee.in`;
      const username = `bot_${p.alias.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16)}`;
      const dob = `${2026 - p.age}-01-01`;
      await db.execute(sql`
        INSERT INTO users (id, email, password_hash, username, gender, date_of_birth, created_at)
        VALUES (
          ${p.id}::uuid,
          ${email},
          'dummy_hash_for_sim_persona',
          ${username},
          ${p.gender}::gender,
          ${dob}::date,
          now()
        )
        ON CONFLICT (id) DO NOTHING
      `);
    } catch {
      // ignore
    }
  }
}
