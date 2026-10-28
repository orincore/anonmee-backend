import type { Gender } from "../../contracts";
import type { Disposition } from "./chat.persona";
import type { Stance } from "./chat.crowd";
import type { Heat } from "./chat.safety";

export interface SimulatedPersona {
  id: string; // e.g. "sim:f:01" or uuid
  alias: string;
  gender: Gender;
  age: number;
  interests: string[];
  vibe: "playful" | "witty" | "chill" | "flirty" | "night_owl" | "bubbly";
  /** 1:1 only: how agreeable this AI user is. Most are cooperative. */
  disposition?: Disposition;
  /** 1:1 only: one trait that makes this AI user different from the next. */
  quirk?: string;
  /** 1:1 only: how this AI user is when the chat turns flirty or sexual. */
  flirt?: string;
  /** 1:1 only: how far this chat may go, set from what the real person signed up for. */
  heat?: Heat;
}

export interface SimulationMessageContext {
  messages: Array<{
    alias: string;
    gender?: Gender;
    age?: number;
    text: string;
    isReal?: boolean;
    at?: number;
  }>;
  targetPersona: SimulatedPersona;
  realUserGender?: Gender;
  roomType: "global" | "group" | "direct";
  groupTopic?: string;
  /** Human readable name of the group, a better theme than the internal topic tag. */
  groupTitle?: string;
  isDirectChat?: boolean;
  /** Keeps the memory of what was already said separate per room or chat. */
  roomKey?: string;
  /** The one message this reply answers. Without it (and with history) the persona starts a fresh topic. */
  replyTo?: { alias: string; text: string };
  /** 1:1 only: how many short messages to write for this turn (default 1). */
  maxBubbles?: number;
  /** How far the persona may go. Shared rooms are capped below "explicit" no matter what is passed. */
  heat?: Heat;
  /** The topic a real person raised that the room is still on. Replies stay in it. */
  roomTopic?: string;
  /** A few example exchanges that show how people really text. The feel, not lines to copy. */
  examples?: { they: string; you: string }[];
  /** Ten fresh swear words for this request, so rooms do not hear the same few all night. */
  gaalis?: string[];
  /** The attitude this persona takes toward the message it answers. */
  stance?: Stance;
  /** What to talk about when starting a topic, so openers do not all sound alike. */
  topicSeed?: string;
}

/** One planned message of a generated conversation. */
export interface ScriptLine {
  /** Index into the cast the script was written for. */
  speaker: number;
  text: string;
  /** Index of an earlier line in the same script that this one directly answers. */
  replyTo?: number;
}
