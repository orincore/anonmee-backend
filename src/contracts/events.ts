import { z } from "zod";
import type { Gender } from "./auth";
export type { Gender };

/** Single source of truth for socket event names. Never use string literals elsewhere. */
export const EV = {
  presenceCount: "presence:count",
  matchJoin: "match:join",
  matchLeave: "match:leave",
  matchFound: "match:found",
  matchTimeout: "match:timeout",
  chatMessage: "chat:message",
  chatTyping: "chat:typing",
  chatEnd: "chat:end",
  chatSkip: "chat:skip",
  roomJoin: "room:join",
  roomLeave: "room:leave",
  roomMessage: "room:message",
  roomTyping: "room:typing",
  chatResume: "chat:resume",
  chatActive: "chat:active",
  roomHistory: "room:history",
  chatReact: "chat:react",
  chatReactions: "chat:reactions",
  roomReact: "room:react",
  roomReactions: "room:reactions",
  roomRead: "room:read",
  groupCreated: "group:created",
  pulse: "pulse:event",
  error: "error",
} as const;

/** One line of the public live ticker. Carries no user information: the kind of chat, or a public group title. */
export type PulseEvent =
  | { kind: "match"; intent: string; at: number }
  | { kind: "group"; title: string; topic: string; at: number };

export const matchJoinSchema = z.object({}).strict();
/** The small fixed set people can react with. A closed set keeps reactions friendly and easy to count. */
export const REACTIONS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F525}"] as const;
export type Reaction = (typeof REACTIONS)[number];

export const chatMessageSchema = z.object({
  roomId: z.string().min(1).max(64),
  clientMsgId: z.string().min(8).max(64),
  text: z.string().min(1).max(4000),
  /** Reply to an earlier message in the same chat. The server copies the quoted text, so it cannot be faked. */
  replyToId: z.string().uuid().optional(),
});
export const reactSchema = z.object({
  roomId: z.string().min(1).max(64),
  messageId: z.string().uuid(),
  emoji: z.enum(REACTIONS),
});
export const roomRefSchema = z.object({ roomId: z.string().min(1).max(64) });
export const roomReadSchema = z.object({
  roomId: z.string().min(1).max(64),
  seq: z.number().int().nonnegative().optional(),
});
export const resumeSchema = z.object({ roomId: z.string().min(1).max(64), lastSeq: z.number().int().min(0) });


/** The only real information about a person that another user ever receives. */
export interface PeerView {
  alias: string;
  gender: Gender;
  age: number;
}

export const messageSchema = z.object({
  roomId: z.string().min(1).max(64),
  text: z.string().trim().min(1).max(2000),
});
export type MessageInput = z.infer<typeof messageSchema>;

/** A short quote of the message being replied to. */
export interface ReplyPreview {
  id: string;
  alias: string;
  text: string;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  clientMsgId: string;
  /** Per-room increasing number. Clients use it to order messages and to ask for what they missed. */
  seq: number;
  /** Per-room random alias. Never the account username. */
  alias: string;
  /** The only real info other users may see: gender and age. */
  gender: Gender;
  age: number;
  text: string;
  at: number;
  replyTo?: ReplyPreview;
  /** How many people used each reaction. Never who. */
  reactions?: Record<string, number>;
  /** The reactions you yourself have put on it. */
  mine?: string[];
}

export const roomOlderSchema = z.object({
  roomId: z.string().min(1).max(64),
  beforeSeq: z.number().int().min(1),
  limit: z.number().int().min(1).max(100).default(50),
});

export const roomJoinSchema = z.object({
  roomId: z.string().min(1).max(64),
  /** Last message number the client has. Omit on first join to get recent history. */
  lastSeq: z.number().int().min(0).optional(),
});

/** Sent when someone in a room starts typing. The server turns it into a shared typing view: who is typing, shown by alias only. */
export const roomTypingSchema = z.object({ roomId: z.string().min(1).max(64) });

/** Broadcast to a room whenever the set of typists changes. Only aliases, never ids. Auto-clears after silence. */
export interface RoomTypingView {
  roomId: string;
  /** Aliases of people currently typing (excluding yourself on your socket). */
  typists: string[];
}

/** 1:1 typing payload. Per spec only gender/age are ever shown to the peer, so the typing event carries only roomId. */
export type ChatTypingPayload = { roomId: string };
