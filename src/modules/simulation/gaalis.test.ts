import { describe, expect, it } from "vitest";
import { GAALI_PHRASES, GAALI_POOL, GAALI_WORDS, pickGaalis, STAPLES } from "./gaalis";

const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

describe("the pool", () => {
  it("has at least 500 distinct entries", () => {
    expect(GAALI_POOL.length).toBeGreaterThanOrEqual(500);
    expect(new Set(GAALI_POOL).size).toBe(GAALI_POOL.length);
  });

  it("includes gender-based and sexual abuse, which the owner allows", () => {
    for (const w of ["randi", "kutiya", "gaand marao", "lund choos"]) expect(GAALI_POOL).toContain(w);
  });

  it("includes abuse based on private parts, which the owner allows", () => {
    for (const w of ["lund", "gaand", "chut", "tatte", "gote", "lund ke baal"]) expect(GAALI_POOL).toContain(w);
    expect(GAALI_POOL.filter((p) => /lund|lauda|lavda|chut|choot|gaand|bhosd|jhaant|tatte|gote|lulli/.test(p)).length).toBeGreaterThanOrEqual(60);
  });

  it("includes abuse about a mother or sister, which the owner allows", () => {
    for (const w of ["teri maa ki", "teri behen ki", "maa chod", "behen chod", "madarchod"]) expect(GAALI_POOL).toContain(w);
    expect(GAALI_POOL.filter((p) => /maa|behen|bhen|madar/.test(p)).length).toBeGreaterThanOrEqual(25);
  });

  it("never includes a threat or wish of rape or violence", () => {
    for (const e of GAALI_POOL) {
      expect(e).not.toMatch(/\b(rape|balatkar|maar dunga|maar dalunga|jaan se|kill|murder|khatam)\b/i);
      // Nor the "I will do this to you" forms that are threats of assault or bodily harm, however they are worded.
      expect(e).not.toMatch(/\b(daal\s*(dunga|dungi|dalunga|dalungi|denge)|tod\s*(dunga|dungi|dalunga|dalungi|denge)|faad\s*(dunga|dungi|dalunga)|phod\s*(dunga|dungi|dalunga)|kaat\s*(dunga|dungi|dalunga))\b/i);
    }
    expect(GAALI_POOL.some((p) => p.startsWith("saali "))).toBe(true);
  });

  it("has real variety in single words, and phrases on top", () => {
    expect(GAALI_WORDS.length).toBeGreaterThanOrEqual(170);
    expect(GAALI_PHRASES.length).toBeGreaterThanOrEqual(450);
  });

  it("keeps out religion and caste, and slurs about trans or gay identity, ethnicity, region and disability", () => {
    const banned = [
      // religion and caste
      "chamar", "bhangi", "dalit", "katua", "kafir", "mulla", "musalman", "mohammedan", "pandit", "baniya", "jaat", "chuhra", "shudra", "dhobi", "kaafir",
      // trans and gay identity, ethnicity, region
      "chakka", "hijra", "hijda", "hijde", "kinnar", "meetha", "paki", "nepali", "bihari", "madrasi", "chinki", "bhaiya", "habshi", "kallu",
      // disability, skin
      "langda", "lula", "andha", "bahra", "behra", "gunga", "mental", "retard", "spastic", "moti", "kaali", "kaala",
    ];
    for (const entry of GAALI_POOL) {
      for (const bad of banned) expect(entry, `"${entry}" must not contain "${bad}"`).not.toMatch(new RegExp(`(^|\\s)${bad}(\\s|$)`, "i"));
    }
  });

  it("keeps entries short and plain text", () => {
    for (const e of GAALI_POOL) {
      expect(e.length).toBeLessThanOrEqual(40);
      expect(e).toBe(e.toLowerCase());
      expect(e).not.toMatch(/[<>{}\[\]\\/]/);
    }
  });

  it("does not put the staples in the pool, they are always allowed anyway", () => {
    for (const s of STAPLES) expect(GAALI_POOL).not.toContain(s);
  });
});

describe("pickGaalis", () => {
  it("gives ten distinct entries, mostly single words with some phrases", () => {
    for (let i = 1; i <= 100; i++) {
      const p = pickGaalis([], 10, seeded(i));
      expect(p).toHaveLength(10);
      expect(new Set(p).size).toBe(10);
      expect(p.filter((x) => GAALI_WORDS.includes(x)).length).toBe(6);
      expect(p.filter((x) => GAALI_PHRASES.includes(x)).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("never offers the same ones again while there are fresh ones", () => {
    const seen = new Set<string>();
    for (let round = 0; round < 30; round++) {
      const p = pickGaalis(seen, 10, seeded(round + 1));
      for (const x of p) expect(seen.has(x)).toBe(false);
      p.forEach((x) => seen.add(x));
    }
    expect(seen.size).toBe(300);
  });

  it("is different every time", () => {
    const first = pickGaalis([], 10, seeded(1)).join("|");
    const later = new Set(Array.from({ length: 50 }, (_, i) => pickGaalis([], 10, seeded(i + 2)).join("|")));
    expect(later.has(first)).toBe(false);
    expect(later.size).toBeGreaterThan(45);
  });

  it("starts over rather than offering nothing when everything was used", () => {
    const p = pickGaalis(GAALI_POOL, 10, seeded(3));
    expect(p).toHaveLength(10);
    expect(new Set(p).size).toBe(10);
  });

  it("never offers a staple as a fresh one", () => {
    for (let i = 1; i <= 50; i++) for (const x of pickGaalis([], 10, seeded(i))) expect((STAPLES as readonly string[]).includes(x)).toBe(false);
  });
});
