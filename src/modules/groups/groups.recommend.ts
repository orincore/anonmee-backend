export interface GroupCandidate {
  id: string;
  topic: string;
  tags: string[];
  memberCount: number;
  messagesLast10m: number;
  createdAt: number; // ms epoch
  ownerId: string;
}

export interface Viewer {
  userId: string;
  interests: string[];
  joinedGroupIds: ReadonlySet<string>;
  blockedUserIds: ReadonlySet<string>;
}

const W = { interest: 0.45, activity: 0.2, fresh: 0.15, size: 0.1, popular: 0.1 } as const;
const FRESH_HALF_LIFE_H = 12;
/** Penalty applied per already-picked group on the same topic, for variety. */
const DIVERSITY_PENALTY = 0.25;

function interestMatch(g: GroupCandidate, interests: readonly string[]): number {
  if (interests.length === 0) return 0;
  const want = new Set(interests);
  const have = new Set([g.topic, ...g.tags]);
  let hit = 0;
  for (const x of have) if (want.has(x)) hit += 1;
  return Math.min(hit / Math.min(want.size, 3), 1);
}

/** Groups that cannot be shown at all: already joined, or owned by someone the viewer blocked. There is no member cap. */
function visible(g: GroupCandidate, v: Viewer): boolean {
  return !v.joinedGroupIds.has(g.id) && !v.blockedUserIds.has(g.ownerId);
}

export function groupScore(g: GroupCandidate, v: Viewer, now: number): number {
  const activity = Math.min(Math.log1p(g.messagesLast10m) / Math.log1p(60), 1);
  const ageH = Math.max(now - g.createdAt, 0) / 3_600_000;
  const fresh = Math.pow(0.5, ageH / FRESH_HALF_LIFE_H);
  // A room with one person feels dead; from 3 people it feels alive.
  const size = g.memberCount < 2 ? 0.2 : g.memberCount < 3 ? 0.6 : 1;
  const popular = Math.min(Math.log1p(g.memberCount) / Math.log1p(200), 1);

  return (
    W.interest * interestMatch(g, v.interests) +
    W.activity * activity +
    W.fresh * fresh +
    W.size * size +
    W.popular * popular
  );
}

/**
 * Ranked list for a viewer. Greedy re-ranking: after each pick, groups on an
 * already-chosen topic lose a bit of score so the top results stay varied.
 * Cold start (no interests) falls back to activity, freshness and size.
 */
export function recommendGroups(
  groups: readonly GroupCandidate[],
  viewer: Viewer,
  now: number,
  limit = 20,
): GroupCandidate[] {
  const pool = groups
    .filter((g) => visible(g, viewer))
    .map((g) => ({ g, base: groupScore(g, viewer, now) }));

  const picked: GroupCandidate[] = [];
  const topicCount = new Map<string, number>();
  while (picked.length < limit && pool.length > 0) {
    let bi = 0;
    let bs = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i]!;
      const s = p.base - DIVERSITY_PENALTY * (topicCount.get(p.g.topic) ?? 0) * p.base;
      if (s > bs || (s === bs && p.g.id < pool[bi]!.g.id)) {
        bs = s;
        bi = i;
      }
    }
    const [chosen] = pool.splice(bi, 1);
    picked.push(chosen!.g);
    topicCount.set(chosen!.g.topic, (topicCount.get(chosen!.g.topic) ?? 0) + 1);
  }
  return picked;
}
