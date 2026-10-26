import { isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { groups } from "../../db/schema";
import type { RedisClient } from "../../lib/redis";

export const INDEXNOW_KEY = "anonmeeindexnow2026";
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export interface IndexNowResult {
  ok: boolean;
  status: number;
  count: number;
  host: string;
  keyLocation: string;
  submittedAt: number;
  error?: string;
}

export async function submitToIndexNow(webOrigin: string, redis: RedisClient, db: Db): Promise<IndexNowResult> {
  const host = new URL(webOrigin).hostname;
  const keyLocation = `${webOrigin}/${INDEXNOW_KEY}.txt`;

  let urlList: string[] = [];

  // Try fetching dynamic sitemap
  try {
    const sitemapUrl = `${webOrigin}/sitemap.xml`;
    const res = await fetch(sitemapUrl, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const xml = await res.text();
      const matches = Array.from(xml.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/g));
      urlList = Array.from(new Set(matches.map((m) => m[1].trim())));
    }
  } catch {
    // If fetching sitemap fails, continue to fallback list
  }

  // Fallback to static + database URLs if sitemap was empty or unreachable
  if (urlList.length === 0) {
    const staticPaths = [
      "",
      "/global-chat",
      "/groups",
      "/groups/global",
      "/about",
      "/safety",
      "/faq",
      "/community-guidelines",
      "/child-safety",
      "/privacy",
      "/terms",
      "/contact",
      "/grievance",
      "/locations",
      "/for",
      "/topics/dating",
      "/topics/friendship",
      "/topics/stranger-chat",
      "/topics/confessions",
      "/topics/deep-talks",
      "/topics/flirting",
      "/topics/breakup",
      "/topics/lgbtq",
      "/topics/mental-health",
      "/topics/venting",
      "/topics/college",
      "/topics/gaming",
      "/topics/movies",
      "/topics/anime",
      "/for/introverts",
      "/for/college-students",
      "/for/singles",
      "/for/heartbroken",
      "/for/night-owls",
      "/for/adults-18-plus",
      "/locations/united-states",
      "/locations/india",
      "/locations/united-kingdom",
      "/locations/canada",
      "/locations/australia",
      "/locations/germany",
    ];
    urlList = staticPaths.map((p) => `${webOrigin}${p}`);

    try {
      const publicGroups = await db.select({ id: groups.id }).from(groups).where(isNull(groups.closedAt)).limit(100);
      for (const g of publicGroups) {
        urlList.push(`${webOrigin}/groups/${g.id}`);
      }
    } catch {
      // ignore db errors
    }
  }

  const payload = {
    host,
    key: INDEXNOW_KEY,
    keyLocation,
    urlList,
  };

  const now = Date.now();

  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    const isOk = res.status === 200 || res.status === 202;
    const result: IndexNowResult = {
      ok: isOk,
      status: res.status,
      count: urlList.length,
      host,
      keyLocation,
      submittedAt: now,
      error: !isOk ? `Search engines returned HTTP ${res.status}` : undefined,
    };

    await redis.set("admin:indexnow:last", JSON.stringify(result));
    return result;
  } catch (err) {
    const result: IndexNowResult = {
      ok: false,
      status: 0,
      count: urlList.length,
      host,
      keyLocation,
      submittedAt: now,
      error: err instanceof Error ? err.message : "Failed to contact IndexNow API",
    };

    await redis.set("admin:indexnow:last", JSON.stringify(result));
    return result;
  }
}
