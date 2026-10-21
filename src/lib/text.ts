// Zero-width and control characters are stripped so messages cannot hide content or spoof layout.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤﻿]/g;

/** Normalises chat text. Returns null when nothing visible is left. Plain text only: never rendered as HTML. */
export function cleanMessage(raw: string, max = 2000): string | null {
  const t = raw.replace(INVISIBLE, "").replace(/\s+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!t || t.length > max) return null;
  return t;
}
