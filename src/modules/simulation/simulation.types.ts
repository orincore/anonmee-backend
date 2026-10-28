import type { Gender } from "../../contracts";

export interface SimulatedPersona {
  id: string; // e.g. "sim:f:01" or uuid
  alias: string;
  gender: "female" | "male";
  age: number;
  interests: string[];
  vibe: "playful" | "witty" | "chill" | "flirty" | "night_owl" | "bubbly";
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
  isDirectChat?: boolean;
}
