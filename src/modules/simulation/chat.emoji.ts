/**
 * Makes emoji use look like people typing instead of a model: not always at the end, sometimes doubled,
 * and never the same one again and again. Pure, free (no tokens), unit tested.
 */

const CLUSTER = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*/gu;
const base = (e: string) => e.replace(/️/g, "");

/** Emojis of the same feeling, so swapping one keeps the meaning. */
const GROUPS: string[][] = [
  ["😂", "🤣", "😭", "💀", "😆", "😹"],
  ["😏", "😉", "😜", "🙄", "😒", "🤭"],
  ["🥺", "😔", "😢", "😞", "🥲"],
  ["🔥", "😍", "🥵", "😈", "😘", "💋"],
  ["😅", "🤦", "🤷", "🙃", "😬", "😤"],
  ["👀", "💯", "🙌", "👏", "🤌"],
  ["❤️", "💕", "🫶", "😊", "🥰"],
];

export const emojisIn = (text: string): string[] => (text.match(CLUSTER) ?? []).map(base);

type Rng = () => number;
const pick = <T>(items: T[], rng: Rng) => items[Math.floor(rng() * items.length)]!;

/** Emojis already used in the last few messages are swapped for a fresh one of the same feeling. */
function freshen(text: string, recent: string[], rng: Rng): string {
  return text
    .replace(CLUSTER, (e) => {
      if (!recent.includes(base(e))) return e;
      const group = GROUPS.find((g) => g.some((x) => base(x) === base(e)));
      const options = group?.filter((x) => !recent.includes(base(x))) ?? [];
      return options.length ? pick(options, rng) : rng() < 0.5 ? "" : e;
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Where the emoji sits and how many there are, instead of always one at the end. */
function place(text: string, rng: Rng): string {
  const m = text.match(new RegExp(`^(.*?\\S)\\s*((?:${CLUSTER.source})+)$`, "su"));
  if (!m) return text; // no emoji, an emoji in the middle already, or nothing but emoji
  const [, body, tail] = m as unknown as [string, string, string];
  const roll = rng();
  if (roll < 0.3) return `${tail} ${body}`; // at the start
  if (roll < 0.5) {
    const words = body.split(" ");
    const at = Math.min(words.length - 1, 1 + Math.floor(rng() * 3)); // after the first one to three words
    if (at >= 1 && words.length > 2) return `${words.slice(0, at).join(" ")} ${tail} ${words.slice(at).join(" ")}`;
  }
  if (roll < 0.7) return `${body} ${tail.repeat(rng() < 0.7 ? 2 : 3)}`; // doubled or tripled
  return text; // some stay where the model put them
}

export function mixEmoji(text: string, recent: string[] = [], rng: Rng = Math.random): string {
  if (!CLUSTER.test(text)) return text;
  CLUSTER.lastIndex = 0;
  const out = place(freshen(text, recent, rng), rng);
  return out.trim() || text;
}
