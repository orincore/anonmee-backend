/** Pure rule for whether AI chatter may run at all. No I/O, unit tested. */
export interface GateInputs {
  enabled: boolean;
  budgetLeft: boolean;
  /** Real, signed-in people connected right now. Bots never hold a socket, so they are not in this number. */
  humansOnline: number;
  /** Pause above this many people (they keep each other busy). 0 means no limit. */
  maxHumans: number;
}

export function botsMayRun(i: GateInputs): boolean {
  if (!i.enabled || !i.budgetLeft) return false;
  if (i.humansOnline <= 0) return false; // nobody here: no chatter, no model calls
  return i.maxHumans === 0 || i.humansOnline <= i.maxHumans;
}
