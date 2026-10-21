export type Channel = "seo" | "llm" | "utm" | "social" | "referral" | "direct";

export interface Attribution {
  channel: Channel;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  campaignCode: string | null;
  referrerHost: string | null;
}

const SEARCH = ["google.", "bing.com", "duckduckgo.com", "yahoo.", "baidu.com", "yandex.", "ecosia.org", "brave.com", "startpage.com"];
const LLM = ["chatgpt.com", "chat.openai.com", "perplexity.ai", "claude.ai", "gemini.google.com", "copilot.microsoft.com", "you.com", "phind.com"];
const SOCIAL = ["facebook.com", "instagram.com", "t.co", "twitter.com", "x.com", "reddit.com", "tiktok.com", "youtube.com", "linkedin.com", "pinterest.com", "snapchat.com", "t.me", "telegram.org", "whatsapp.com", "discord.com", "threads.net"];
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|preview|headless|lighthouse|pingdom|uptime/i;

export function isBot(userAgent: string | undefined): boolean {
  return !userAgent || BOT_UA.test(userAgent);
}

function hostOf(referrer: string | undefined, ownHost: string): string | null {
  if (!referrer) return null;
  try {
    const h = new URL(referrer).hostname.replace(/^www\./, "");
    return h === ownHost.replace(/^www\./, "") ? null : h; // internal navigation is not a source
  } catch {
    return null;
  }
}

const clean = (v: string | null): string | null => {
  const t = v?.trim().toLowerCase().slice(0, 80);
  return t ? t : null;
};

const matches = (host: string, list: string[]) => list.some((d) => host.includes(d));

/**
 * Where did this visit come from? An explicit UTM tag always wins, so a link the team shared
 * is never miscounted as organic. Otherwise the referrer decides: search engines are SEO,
 * AI assistants are LLM, social sites are social, anything else is a referral, no referrer is direct.
 */
export function classifyVisit(url: URL, referrer: string | undefined, ownHost: string): Attribution {
  const q = url.searchParams;
  const utm = {
    source: clean(q.get("utm_source")),
    medium: clean(q.get("utm_medium")),
    campaign: clean(q.get("utm_campaign")),
    content: clean(q.get("utm_content")),
    term: clean(q.get("utm_term")),
  };
  const referrerHost = hostOf(referrer, ownHost);
  const campaignCode = clean(q.get("utm_id"));

  if (utm.source || utm.campaign || utm.medium || campaignCode) return { channel: "utm", ...utm, campaignCode, referrerHost };
  const none = { medium: null, campaign: null, content: null, term: null, campaignCode: null };
  if (!referrerHost) return { channel: "direct", source: null, ...none, referrerHost };
  if (matches(referrerHost, SEARCH)) return { channel: "seo", source: referrerHost, ...none, medium: "organic", referrerHost };
  if (matches(referrerHost, LLM)) return { channel: "llm", source: referrerHost, ...none, medium: "ai-assistant", referrerHost };
  if (matches(referrerHost, SOCIAL)) return { channel: "social", source: referrerHost, ...none, medium: "social", referrerHost };
  return { channel: "referral", source: referrerHost, ...none, medium: "referral", referrerHost };
}

/** Builds the full tagged URL for a campaign, used by the admin link builder. */
export function buildCampaignUrl(
  base: string,
  c: { source: string; medium: string; campaign: string; content?: string | null; targetPath?: string },
): string {
  const u = new URL(c.targetPath ?? "/", base);
  u.searchParams.set("utm_source", c.source.trim().toLowerCase());
  u.searchParams.set("utm_medium", c.medium.trim().toLowerCase());
  u.searchParams.set("utm_campaign", c.campaign.trim().toLowerCase());
  if (c.content) u.searchParams.set("utm_content", c.content.trim().toLowerCase());
  return u.toString();
}
