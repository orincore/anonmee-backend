import { describe, expect, it } from "vitest";
import { mixStances, planCrowd, type Stance } from "./chat.crowd";
import { getAllPersonas } from "./persona.service";

const pool = getAllPersonas();
/** Deterministic rng so a failure can be reproduced. */
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const runs = Array.from({ length: 200 }, (_, i) => i + 1);

describe("mixStances", () => {
  it("always has a warm and a sharp voice once there are three people", () => {
    for (const n of runs) {
      const s = mixStances(4, seeded(n));
      expect(s.some((x) => x === "flirty" || x === "romantic")).toBe(true);
      expect(s.some((x) => x === "roast" || x === "cold")).toBe(true);
    }
  });

  it("never leaves a crowd without someone on the person's side", () => {
    for (const n of runs) {
      for (const count of [2, 3, 4]) expect(mixStances(count, seeded(n))).toContain("support");
      expect(mixStances(3, seeded(n), true)).toContain("support");
    }
  });

  it("never gives the same attitude to more than two people", () => {
    for (const n of runs) {
      const s = mixStances(4, seeded(n));
      for (const st of new Set(s)) expect(s.filter((x) => x === st).length).toBeLessThanOrEqual(2);
    }
  });

  it("calm mode has no flirting, roasting or cold shoulder", () => {
    const harsh: Stance[] = ["flirty", "romantic", "roast", "cold"];
    for (const n of runs) expect(mixStances(3, seeded(n), true).some((x) => harsh.includes(x))).toBe(false);
  });
});

describe("when the person is sexting", () => {
  const playing = (xs: string[]) => xs.filter((x) => x === "heated" || x === "heated_invite");

  it("the room plays along: most voices are heated, nobody gives a flat refusal", () => {
    for (const n of runs) {
      for (const count of [2, 3, 4]) {
        const s = mixStances(count, seeded(n), false, true);
        expect(s.filter((x) => x === "cold"), `count ${count}`).toEqual([]);
        expect(playing(s).length).toBeGreaterThanOrEqual(Math.min(count, 2));
      }
    }
  });

  it("at most one voice invites them to a private chat, and with enough people there is one playful roast", () => {
    for (const n of runs) {
      const s = mixStances(4, seeded(n), false, true);
      expect(s.filter((x) => x === "heated_invite")).toHaveLength(1);
      expect(s.filter((x) => x === "roast")).toHaveLength(1);
      expect(playing(s)).toHaveLength(3);
    }
  });

  it("calm mode still wins: asking for calm means no heat at all", () => {
    for (const n of runs) expect(playing(mixStances(3, seeded(n), true, true))).toEqual([]);
  });

  it("a plan for a sexual message plays along and keeps it with the side the person likely wants", () => {
    let heated = 0;
    let fromWomen = 0;
    for (const n of runs) {
      const plan = planCrowd(pool, { userGender: "male", heated: true }, seeded(n));
      expect(plan.some((p) => p.stance === "heated")).toBe(true);
      expect(plan.some((p) => p.stance === "cold")).toBe(false);
      for (const step of plan) if (step.stance === "heated" || step.stance === "heated_invite") {
        heated++;
        if (step.persona.gender === "female" || step.persona.gender === "trans_woman") fromWomen++;
      }
    }
    expect(fromWomen / heated).toBeGreaterThan(0.9);
  });
});

describe("planCrowd", () => {
  it("answers a first message with three or four different personas, never the author", () => {
    for (const n of runs) {
      const me = pool[n % pool.length]!;
      const plan = planCrowd(pool, { exclude: [me.alias], userGender: "male" }, seeded(n));
      expect(plan.length).toBeGreaterThanOrEqual(3);
      expect(plan.length).toBeLessThanOrEqual(4);
      expect(new Set(plan.map((p) => p.persona.id)).size).toBe(plan.length);
      expect(plan.some((p) => p.persona.alias === me.alias)).toBe(false);
    }
  });

  it("a full plan always has a supporter, even with the person's gender unknown", () => {
    for (const n of runs) expect(planCrowd(pool, {}, seeded(n)).some((s) => s.stance === "support")).toBe(true);
  });

  it("uses fewer replies for a follow-up", () => {
    for (const n of runs) expect(planCrowd(pool, { followUp: true }, seeded(n)).length).toBeLessThanOrEqual(3);
  });

  it("lets the side the person likely wants do the flirting", () => {
    let flirts = 0;
    let fromWomen = 0;
    for (const n of runs) {
      for (const step of planCrowd(pool, { userGender: "male" }, seeded(n))) {
        if (step.stance === "flirty" || step.stance === "romantic") {
          flirts++;
          if (step.persona.gender === "female" || step.persona.gender === "trans_woman") fromWomen++;
        }
      }
    }
    expect(fromWomen / flirts).toBeGreaterThan(0.9);
  });

  it("prefers voices that have not just spoken, and never answers on a fixed beat", () => {
    const recent = pool.slice(0, 10).map((p) => p.alias);
    const plan = planCrowd(pool, { recentAliases: recent, messageLength: 40 }, seeded(7));
    expect(plan.every((p) => !recent.includes(p.persona.alias))).toBe(true);
    expect(plan[0]!.delayMs).toBeGreaterThanOrEqual(2000); // never instant
    expect(plan[0]!.quote).toBe(true);
    plan.slice(1).forEach((p) => expect(p.delayMs).toBeGreaterThanOrEqual(2000));
    const firsts = new Set(runs.map((n) => planCrowd(pool, { messageLength: 40 }, seeded(n))[0]!.delayMs));
    expect(firsts.size).toBeGreaterThan(150);
  });

  it("copes with a tiny pool", () => {
    expect(planCrowd(pool.slice(0, 2), {}, seeded(1)).length).toBe(2);
    expect(planCrowd([], {}, seeded(1))).toEqual([]);
  });
});
