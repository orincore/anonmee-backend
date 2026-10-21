import { z } from "zod";
import { GENDERS, MIN_AGE } from "./auth";

const RELATIONSHIP = ["long_term", "marriage_minded", "casual_dating", "flirting", "friends_with_benefits", "one_night_stand", "sexting", "online_romance"] as const;
const OPEN_MINDED = ["open_relationship", "polyamory", "two_way", "three_way", "four_way", "group_relationship", "same_gender", "bi_curious", "couples", "role_play", "kink_friendly", "exploring"] as const;

/** Every option someone can pick, in the order they are shown. */
export const INTENTS = ["friendship", "casual_chat", ...RELATIONSHIP, ...OPEN_MINDED, "other"] as const;
export type Intent = (typeof INTENTS)[number];

/**
 * What a person is here for, in two levels. The group is what they see first; "Dating and relationships" and
 * "Open-minded" open up specific options. Matching works on the specific options, so two people are only paired
 * when they share at least one exact choice. Everything here is for adults who have confirmed they are 18 or older,
 * in text-only chat, with report and block always available.
 */
export const INTENT_GROUPS = [
  { id: "friendship", label: "Friendship", intents: ["friendship"] },
  { id: "casual", label: "Casual chat", intents: ["casual_chat"] },
  { id: "relationships", label: "Dating and relationships", intents: RELATIONSHIP },
  { id: "open_minded", label: "Open-minded", intents: OPEN_MINDED },
  { id: "other", label: "Something else", intents: ["other"] },
] as const;
export type IntentGroupId = (typeof INTENT_GROUPS)[number]["id"];

export const INTENT_LABELS: Record<Intent, string> = {
  friendship: "Friendship",
  casual_chat: "Casual chat",
  long_term: "Long-term relationship",
  marriage_minded: "Marriage minded",
  casual_dating: "Casual dating",
  flirting: "Flirting",
  friends_with_benefits: "Friends with benefits",
  one_night_stand: "One night stand",
  sexting: "Sexting",
  online_romance: "Online romance",
  open_relationship: "Open relationship",
  polyamory: "Polyamory",
  two_way: "2-way relationship",
  three_way: "3-way relationship",
  four_way: "4-way relationship",
  group_relationship: "Group relationship",
  same_gender: "Same gender",
  bi_curious: "Bi-curious",
  couples: "Couples",
  role_play: "Role play",
  kink_friendly: "Kink friendly",
  exploring: "Still exploring",
  other: "Something else",
};

/**
 * "Same gender" is a condition, not a topic: it only counts as a shared choice between two people who really are
 * the same gender as each other. Used by the matcher so it can never pair two different genders on it.
 */
export const SAME_GENDER: Intent = "same_gender";

/** True for the options we offer today (older saved values are ignored). */
export const isIntent = (x: string): x is Intent => (INTENTS as readonly string[]).includes(x);

/** Which group an option belongs to. Public surfaces (like the live ticker) use the group, never the specific option. */
export const groupOfIntent = (i: Intent): IntentGroupId => INTENT_GROUPS.find((g) => (g.intents as readonly string[]).includes(i))!.id;

/** "Friendship, dating and relationships": the groups someone picked, for short summaries. */
export const intentGroupSummary = (intents: readonly Intent[]): string[] =>
  INTENT_GROUPS.filter((g) => g.intents.some((i) => intents.includes(i))).map((g) => g.label.toLowerCase());

export const preferencesSchema = z
  .object({
    intents: z.array(z.enum(INTENTS)).min(1, "Pick at least one thing you are here for").max(INTENTS.length),
    wantGenders: z.array(z.enum(GENDERS)).min(1),
    minAge: z.number().int().min(MIN_AGE).max(99),
    maxAge: z.number().int().min(MIN_AGE).max(99),
    interests: z.array(z.string().trim().toLowerCase().min(2).max(24)).max(12),
  })
  .refine((p) => p.minAge <= p.maxAge, { message: "Min age must not exceed max age" });

export type Preferences = z.infer<typeof preferencesSchema>;

export const createGroupSchema = z.object({
  title: z.string().trim().min(3).max(60),
  topic: z.string().trim().toLowerCase().min(2).max(24),
  description: z.string().trim().max(280).default(""),
});
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
