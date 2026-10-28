import { describe, expect, it } from "vitest";
import { EXAMPLES, exampleKindFor, pickExamples, pickTexture, TEXTURE } from "./hinglish.examples";
import { isBookish, isCoyStall } from "./chat.texting";

const all = Object.values(EXAMPLES).flat();

describe("example exchanges", () => {
  it("cover every tone with enough variety to sample from", () => {
    for (const kind of Object.keys(EXAMPLES) as (keyof typeof EXAMPLES)[]) expect(EXAMPLES[kind].length).toBeGreaterThanOrEqual(6);
    expect(all.length).toBeGreaterThanOrEqual(40);
    expect(new Set(all.map((e) => e.you)).size).toBe(all.length);
  });

  it("sound like texting: lowercase, shortened, mixed with English, never textbook Hindi", () => {
    for (const e of all) {
      expect(isBookish(e.they + " " + e.you)).toBe(false);
      expect(e.you.length).toBeLessThanOrEqual(90);
    }
    const shortened = all.filter((e) => /\b(nhi|h|kr|rha|rhi|bht|mjhe|yr|bc|bsdk)\b/.test(e.you)).length;
    expect(shortened / all.length).toBeGreaterThan(0.6);
  });

  it("keeps out religion, caste, threats and real names", () => {
    const bad = /\b(chamar|bhangi|dalit|katua|kafir|mulla|hijra|chakka|rape|balatkar|maar dunga|daal dunga|tod dunga|kill)\b/i;
    for (const e of all) expect(e.they + " " + e.you).not.toMatch(bad);
    for (const t of TEXTURE) expect(t).not.toMatch(bad);
  });

  it("the sexy ones play along: none refuses or lectures, at most one sends them private, none describes a sex act", () => {
    for (const e of EXAMPLES.sexy) {
      expect(e.you).not.toMatch(/\b(daal|chus|chat|ghus|andar)\b/i);
      expect(e.you).not.toMatch(/yaha nhi|not allowed|allowed nhi|sharam kar|bad baat|gandi baat/i);
    }
    expect(EXAMPLES.sexy.filter((e) => /private|match kr/i.test(e.you)).length).toBeLessThanOrEqual(1);
    expect(EXAMPLES.sexy.length).toBeGreaterThanOrEqual(8);
  });
});

describe("the flirty examples answer and keep the chat going", () => {
  const sets = [["flirty", EXAMPLES.flirty], ["sexy", EXAMPLES.sexy], ["intimate", EXAMPLES.intimate]] as const;

  it("none of them stalls: no comment on how direct they are, no blushing, no demanding they answer first", () => {
    for (const [, set] of sets) for (const e of set) expect(isCoyStall(e.you), `"${e.you}"`).toBe(false);
  });

  it("most end with a hook: a question, a dare, or a thing for them to answer", () => {
    for (const [name, set] of sets) {
      const hooked = set.filter((e) => /\?|\b(?:tu|tum)\s+(?:bata|batao|bol|choose|kr|krega)\b|\bbol\b|\bbata\b|ab teri baari|teri baari/i.test(e.you)).length;
      expect(hooked / set.length, name).toBeGreaterThan(0.7);
    }
  });

  it("there is enough variety in the 1:1 set to sample from", () => {
    expect(EXAMPLES.intimate.length).toBeGreaterThanOrEqual(10);
    expect(new Set(EXAMPLES.intimate.map((e) => e.you.split(" ")[0])).size).toBeGreaterThanOrEqual(6); // they do not all start alike
  });
});

describe("picking examples", () => {
  it("gives n distinct, random ones", () => {
    const a = pickExamples("casual", 4, () => 0.1);
    expect(a).toHaveLength(4);
    expect(new Set(a.map((e) => e.you)).size).toBe(4);
    const different = new Set(Array.from({ length: 40 }, () => pickExamples("casual", 4).map((e) => e.you).join("|")));
    expect(different.size).toBeGreaterThan(20);
  });

  it("matches the example tone to what the persona is about to do", () => {
    expect(exampleKindFor("roast")).toBe("roast");
    expect(exampleKindFor("cold")).toBe("roast");
    expect(exampleKindFor("flirty", "flirty")).toBe("flirty");
    expect(exampleKindFor("flirty", "explicit")).toBe("intimate");
    expect(exampleKindFor("heated")).toBe("sexy");
    expect(exampleKindFor("heated_invite")).toBe("sexy");
    expect(exampleKindFor("support")).toBe("support");
    expect(exampleKindFor("warning_first")).toBe("support");
    expect(exampleKindFor(undefined, "friendly")).toBe("casual");
    expect(exampleKindFor(undefined, "explicit")).toBe("intimate");
    expect(exampleKindFor(undefined, "flirty")).toBe("flirty");
  });

  it("texture lines are short and plentiful", () => {
    expect(pickTexture(8)).toHaveLength(8);
    expect(TEXTURE.length).toBeGreaterThanOrEqual(40);
    for (const t of TEXTURE) expect(t.length).toBeLessThanOrEqual(30);
  });
});
