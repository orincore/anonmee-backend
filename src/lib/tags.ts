/** One canonical spelling per topic so "soccer" and "football" land in the same place. */
const SYNONYMS: Record<string, string> = {
  soccer: "football", futbol: "football", "movies": "film", cinema: "film", films: "film",
  gaming: "games", videogames: "games", "video-games": "games", advices: "advice",
  relationships: "relationship", "mental-health": "wellbeing", mentalhealth: "wellbeing",
  tech: "technology", coding: "technology", programming: "technology", songs: "music",
};

export function normaliseTag(raw: string): string {
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  return SYNONYMS[slug] ?? slug;
}
