import { sql } from "drizzle-orm";
import {
  bigint, check, date, jsonb, uniqueIndex, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uuid, varchar,
} from "drizzle-orm/pg-core";

export const genderEnum = pgEnum("gender", ["male", "female", "non_binary", "prefer_not_to_say", "trans_man", "trans_woman"]);
// Older values (friends, dating, open_minded) stay so existing rows remain valid; they are no longer offered.
export const intentEnum = pgEnum("intent", [
  "friends", "dating", "friendship", "casual_chat", "open_minded", "other",
  "long_term", "marriage_minded", "casual_dating", "flirting", "friends_with_benefits", "one_night_stand", "sexting", "open_relationship", "polyamory", "online_romance",
  "two_way", "three_way", "four_way", "group_relationship", "same_gender", "bi_curious", "couples", "role_play", "kink_friendly", "exploring",
]);
export const channelEnum = pgEnum("channel", ["seo", "llm", "utm", "social", "referral", "direct"]);
export const adminRoleEnum = pgEnum("admin_role", ["owner", "moderator", "analyst"]);
export const reportStatusEnum = pgEnum("report_status", ["open", "reviewed", "actioned", "dismissed"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 254 }).notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    username: varchar("username", { length: 20 }).notNull().unique(),
    gender: genderEnum("gender").notNull(),
    dateOfBirth: date("date_of_birth", { mode: "date" }).notNull(),
    emailVerifiedAt: timestamp("email_verified_at"),
    /** First-touch attribution, copied from the visit that led to sign-up. Marketing data only. */
    acquisitionChannel: channelEnum("acquisition_channel"),
    acquisitionSource: varchar("acquisition_source", { length: 80 }),
    acquisitionCampaign: varchar("acquisition_campaign", { length: 80 }),
    lastSeenAt: timestamp("last_seen_at"),
    bannedAt: timestamp("banned_at"),
    deviceFingerprint: varchar("device_fingerprint", { length: 64 }),
    deviceId: varchar("device_id", { length: 64 }),
    screenTimeSeconds: integer("screen_time_seconds").notNull().default(0),
    createdAt: timestamp("created_at", { precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("users_created_idx").on(t.createdAt, t.id),
    index("users_channel_idx").on(t.acquisitionChannel, t.createdAt),
    index("users_device_fingerprint_idx").on(t.deviceFingerprint),
    index("users_device_id_idx").on(t.deviceId),
    check("users_18_plus", sql`${t.dateOfBirth} <= (current_date - interval '18 years')`),
  ],
);

export const preferences = pgTable("preferences", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  intents: intentEnum("intents").array().notNull(),
  wantGenders: genderEnum("want_genders").array().notNull(),
  minAge: integer("min_age").notNull().default(18),
  maxAge: integer("max_age").notNull().default(99),
  interests: text("interests").array().notNull().default(sql`'{}'::text[]`),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("refresh_user_idx").on(t.userId), index("refresh_expires_idx").on(t.expiresAt)],
);

export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 60 }).notNull(),
    topic: varchar("topic", { length: 24 }).notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    description: varchar("description", { length: 280 }).notNull().default(""),
    /** Kept in step by join and leave, so lists never run count(*) over members. */
    memberCount: integer("member_count").notNull().default(0),
    // Millisecond precision on purpose: keyset cursors carry JS milliseconds, so the column must match exactly.
    createdAt: timestamp("created_at", { precision: 3 }).notNull().defaultNow(),
    closedAt: timestamp("closed_at"),
  },
  (t) => [
    // Ascending on purpose: Postgres reads it backwards for ORDER BY created_at DESC, id DESC, with no sort step.
    index("groups_open_topic_idx").on(t.topic, t.createdAt, t.id).where(sql`${t.closedAt} is null`),
    index("groups_open_created_idx").on(t.createdAt, t.id).where(sql`${t.closedAt} is null`),
    index("groups_tags_gin").using("gin", t.tags),
  ],
);

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** Random per-room alias. Not derivable from the account. */
    alias: varchar("alias", { length: 40 }).notNull(),
    joinedAt: timestamp("joined_at", { precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index("group_members_user_idx").on(t.userId), // "which groups am I in"
    index("group_members_joined_idx").on(t.groupId, t.joinedAt, t.userId), // paged member list
  ],
);

/** Group and global messages only. 1:1 chats stay in Redis and expire when the chat ends. */
export const roomMessages = pgTable(
  "room_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: varchar("room_id", { length: 64 }).notNull(), // "global" or a group id
    seq: bigint("seq", { mode: "number" }).notNull(),
    clientMsgId: varchar("client_msg_id", { length: 64 }).notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    alias: varchar("alias", { length: 40 }).notNull(),
    /** Snapshot at send time, so reading history never joins users. */
    gender: genderEnum("gender").notNull().default("prefer_not_to_say"),
    age: integer("age").notNull().default(18),
    text: varchar("text", { length: 2000 }).notNull(),
    /** Snapshot of the quoted message when this one is a reply. */
    replyTo: jsonb("reply_to").$type<{ id: string; alias: string; text: string }>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("room_messages_created_idx").on(t.createdAt), // retention purge
    index("room_messages_user_idx").on(t.userId, t.createdAt, t.id), // admin: one person's messages, newest first
    uniqueIndex("room_messages_room_seq_uq").on(t.roomId, t.seq),
    uniqueIndex("room_messages_dedupe_uq").on(t.roomId, t.userId, t.clientMsgId),
  ],
);

/**
 * Record of every 1:1 chat, for safety review, legal requests and improving the AI. Staff only; other users never see it.
 * Purged after CHAT_REVIEW_DAYS, and gone with the account (cascade through matches).
 */
export const chatReviewMessages = pgTable(
  "chat_review_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** Author: the real person or the AI user. */
    userId: uuid("user_id").notNull(),
    alias: varchar("alias", { length: 40 }).notNull(),
    text: varchar("text", { length: 2000 }).notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("chat_review_chat_seq_uq").on(t.chatId, t.seq), index("chat_review_created_idx").on(t.createdAt)],
);

export const blocks = pgTable(
  "blocks",
  {
    id: uuid("id").notNull().defaultRandom().unique(),
    /** The alias the blocked person had when it happened. Shown in Me > Blocked, never a real identity. */
    alias: varchar("alias", { length: 40 }),
    blockerId: uuid("blocker_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    blockedId: uuid("blocked_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index("blocks_blocked_idx").on(t.blockedId)],
);

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  reporterId: uuid("reporter_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reportedId: uuid("reported_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roomId: varchar("room_id", { length: 64 }),
  reason: varchar("reason", { length: 400 }).notNull(),
  /** Short retention snapshot of recent messages, purged after review window. */
  evidence: text("evidence"),
  status: reportStatusEnum("status").notNull().default("open"),
  createdAt: timestamp("created_at", { precision: 3 }).notNull().defaultNow(),
}, (t) => [
  index("reports_reported_idx").on(t.reportedId, t.createdAt),
  index("reports_queue_idx").on(t.status, t.createdAt),
]);

/** Staff accounts. Separate from users, created by a CLI seed only, never by public sign-up. */
export const admins = pgTable("admins", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 254 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: adminRoleEnum("role").notNull().default("moderator"),
  /** TOTP secret, encrypted at rest. 2FA is mandatory for every admin. */
  totpSecretEnc: text("totp_secret_enc").notNull(),
  lastLoginAt: timestamp("last_login_at"),
  disabledAt: timestamp("disabled_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** Every time staff open a user record or take an action. Append only. */
export const adminAudit = pgTable(
  "admin_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminId: uuid("admin_id").notNull().references(() => admins.id),
    action: varchar("action", { length: 60 }).notNull(), // e.g. "user.view", "user.ban", "report.dismiss"
    targetUserId: uuid("target_user_id"),
    meta: text("meta"),
    at: timestamp("at").notNull().defaultNow(),
  },
  (t) => [index("admin_audit_admin_idx").on(t.adminId, t.at)],
);

/** One row per browsing session that landed on a public page. No user data, no IP stored. */
export const visits = pgTable(
  "visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    visitorId: uuid("visitor_id").notNull(), // random first-party id, not linked to an account until sign-up
    landingPath: varchar("landing_path", { length: 200 }).notNull(),
    channel: channelEnum("channel").notNull(),
    source: varchar("source", { length: 80 }), // utm_source, or search/LLM/referrer host
    medium: varchar("medium", { length: 80 }),
    campaign: varchar("campaign", { length: 80 }),
    content: varchar("content", { length: 80 }),
    term: varchar("term", { length: 80 }),
    referrerHost: varchar("referrer_host", { length: 120 }),
    campaignCode: varchar("campaign_code", { length: 16 }),
    signedUpUserId: uuid("signed_up_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("visits_time_idx").on(t.createdAt),
    index("visits_channel_idx").on(t.channel, t.createdAt),
    index("visits_campaign_idx").on(t.campaign, t.createdAt),
  ],
);

/** Trackable links the team creates in the admin screen, e.g. anonme.com/r/ab12cd. */
export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 16 }).notNull().unique(),
  name: varchar("name", { length: 80 }).notNull(),
  source: varchar("source", { length: 80 }).notNull(),
  medium: varchar("medium", { length: 80 }).notNull(),
  campaign: varchar("campaign", { length: 80 }).notNull(),
  content: varchar("content", { length: 80 }),
  targetPath: varchar("target_path", { length: 200 }).notNull().default("/"),
  createdBy: uuid("created_by").references(() => admins.id),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** One row per 1:1 chat, for performance analytics and moderation lookups. Messages are not stored here. */
export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userAId: uuid("user_a_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    userBId: uuid("user_b_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    intent: intentEnum("intent").notNull(),
    waitMs: integer("wait_ms").notNull(),
    endedAt: timestamp("ended_at"),
    endedReason: varchar("ended_reason", { length: 20 }), // left | reported | blocked | disconnected
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("matches_time_idx").on(t.createdAt),
    index("matches_user_a_idx").on(t.userAId, t.createdAt, t.id), // admin: one person's chats
    index("matches_user_b_idx").on(t.userBId, t.createdAt, t.id),
  ],
);

export const emailVerificationCodes = pgTable(
  "email_verification_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 254 }).notNull(),
    code: varchar("code", { length: 10 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("email_verification_email_idx").on(t.email),
    index("email_verification_expires_idx").on(t.expiresAt),
  ],
);

export const userActivityDaily = pgTable(
  "user_activity_daily",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    screenTimeSeconds: integer("screen_time_seconds").notNull().default(0),
    messagesSent: integer("messages_sent").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.day] }),
    index("idx_user_activity_daily_day").on(t.day),
  ],
);
