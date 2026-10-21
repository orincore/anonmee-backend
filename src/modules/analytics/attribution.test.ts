import { describe, expect, it } from "vitest";
import { buildCampaignUrl, classifyVisit, isBot } from "./attribution";

const OWN = "anonmee.in";
const u = (path: string) => new URL(`https://anonmee.in${path}`);

describe("classifyVisit", () => {
  it("UTM beats referrer", () => {
    const a = classifyVisit(u("/?utm_source=Reddit&utm_medium=Post&utm_campaign=Launch"), "https://www.google.com/", OWN);
    expect(a).toMatchObject({ channel: "utm", source: "reddit", medium: "post", campaign: "launch" });
  });
  it("search referrer is SEO", () => {
    expect(classifyVisit(u("/"), "https://www.google.com/search?q=x", OWN)).toMatchObject({ channel: "seo", source: "google.com" });
  });
  it("AI assistants are their own channel", () => {
    expect(classifyVisit(u("/"), "https://chatgpt.com/", OWN).channel).toBe("llm");
    expect(classifyVisit(u("/"), "https://www.perplexity.ai/search", OWN).channel).toBe("llm");
  });
  it("social, referral, direct", () => {
    expect(classifyVisit(u("/"), "https://t.co/abc", OWN).channel).toBe("social");
    expect(classifyVisit(u("/"), "https://someblog.com/post", OWN).channel).toBe("referral");
    expect(classifyVisit(u("/"), undefined, OWN).channel).toBe("direct");
  });
  it("own site navigation counts as direct, not a source", () => {
    expect(classifyVisit(u("/"), "https://www.anonmee.in/topics/football", OWN).channel).toBe("direct");
  });
  it("ignores garbage referrers", () => {
    expect(classifyVisit(u("/"), "not a url", OWN).channel).toBe("direct");
  });
});

describe("helpers", () => {
  it("filters bots", () => {
    expect(isBot("Googlebot/2.1")).toBe(true);
    expect(isBot(undefined)).toBe(true);
    expect(isBot("Mozilla/5.0 (iPhone) Safari")).toBe(false);
  });
  it("builds a normalised tagged link", () => {
    const url = buildCampaignUrl("https://anonmee.in", { source: "Reddit", medium: "Post", campaign: "Launch Week" });
    expect(url).toBe("https://anonmee.in/?utm_source=reddit&utm_medium=post&utm_campaign=launch+week");
  });
});
