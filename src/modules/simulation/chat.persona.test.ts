import { describe, expect, it } from "vitest";
import { FLIRT_STYLES, QUIRKS, rollDisposition, rollPersonality, toleranceOf } from "./chat.persona";
import { createDynamicPersona, getAllPersonas } from "./persona.service";
import { isRowdy, personaBrief } from "./chat.quality";
import { isCoyStall } from "./chat.texting";

describe("1:1 personalities", () => {
  it("most AI users are cooperative, but not all", () => {
    const rolls = Array.from({ length: 4000 }, () => rollDisposition());
    const share = (d: string) => rolls.filter((r) => r === d).length / rolls.length;
    expect(share("agreeable")).toBeGreaterThan(0.68);
    expect(share("agreeable")).toBeLessThan(0.82);
    expect(share("neutral")).toBeGreaterThan(0.1);
    expect(share("guarded")).toBeGreaterThan(0.03);
  });

  it("no two AI users in a row feel the same: personality, quirk and texting style all vary", () => {
    const made = Array.from({ length: 60 }, () => createDynamicPersona("female"));
    expect(new Set(made.map((p) => p.quirk)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(made.map((p) => p.vibe)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(made.map((p) => personaBrief(p))).size).toBeGreaterThan(40);
    expect(new Set(made.map((p) => p.alias)).size).toBeGreaterThan(50);
    for (const p of made) expect(QUIRKS).toContain(p.quirk);
  });

  it("the personality reaches the prompt", () => {
    const p = { ...createDynamicPersona("male"), disposition: "agreeable" as const, quirk: QUIRKS[0] };
    expect(personaBrief(p)).toMatch(/go along with what they say/);
    expect(personaBrief(p)).toContain(QUIRKS[0]!);
    expect(personaBrief({ ...p, disposition: "guarded" })).toMatch(/guarded and picky/);
  });

  it("agreeable AI users put up with more than guarded ones, and rowdy ones banter back", () => {
    const calm = { id: "00000000-0000-4000-a001-000000000999" };
    expect(toleranceOf({ ...calm, disposition: "agreeable" })).toBeGreaterThan(toleranceOf({ ...calm, disposition: "neutral" }));
    expect(toleranceOf({ ...calm, disposition: "neutral" })).toBeGreaterThan(toleranceOf({ ...calm, disposition: "guarded" }));
    const rowdy = getAllPersonas().find((p) => isRowdy(p))!;
    const notRowdy = getAllPersonas().find((p) => !isRowdy(p))!;
    expect(toleranceOf({ id: rowdy.id, disposition: "guarded" })).toBe(toleranceOf({ id: notRowdy.id, disposition: "guarded" }) + 3);
  });

  it("every roll has all three parts", () => {
    const r = rollPersonality();
    expect(r.vibe).toBeTruthy();
    expect(r.disposition).toBeTruthy();
    expect(r.quirk).toBeTruthy();
  });

  it("every AI user flirts in its own way, so they do not all answer with the same coy move", () => {
    const made = Array.from({ length: 80 }, () => createDynamicPersona("female"));
    expect(new Set(made.map((p) => p.flirt)).size).toBeGreaterThanOrEqual(6);
    for (const p of made) expect(FLIRT_STYLES).toContain(p.flirt);
    // and it reaches the prompt
    const brief = personaBrief(made[0]!);
    expect(brief).toContain("When the chat turns flirty or sexual, you are");
    expect(brief).toContain(made[0]!.flirt!);
  });

  it("no flirting style is a stall", () => {
    for (const f of FLIRT_STYLES) expect(isCoyStall(f)).toBe(false);
    expect(FLIRT_STYLES.some((f) => /bold and direct/.test(f))).toBe(true);
  });
});
