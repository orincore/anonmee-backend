import type { Gender, Intent } from "../../contracts";

/** A user waiting in the matchmaking pool. Built server side from the DB, never from client input. */
export interface Ticket {
  userId: string;
  gender: Gender;
  age: number;
  intents: Intent[];
  wantGenders: Gender[];
  minAge: number;
  maxAge: number;
  interests: string[];
  blocked: ReadonlySet<string>; // ids blocked in either direction
  recentPartners: ReadonlySet<string>; // cooldown list
  enqueuedAt: number; // ms epoch
}
