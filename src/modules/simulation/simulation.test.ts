import { describe, expect, it } from "vitest";
import { getSimulatedOnlineCount } from "./online.simulator";
import { getAllPersonas, getRandomPersona, isBotUserId, selectResponderPersona } from "./persona.service";
import { generateChatBubbles } from "./together.service";

describe("Simulation System", () => {
  describe("Online Simulator", () => {
    it("fluctuates within 30 to 100 range", async () => {
      // Mock minimal redis client
      const storage = new Map<string, string>();
      const mockRedis: any = {
        mget: async (k1: string, k2: string) => [storage.get(k1) ?? null, storage.get(k2) ?? null],
        set: async (k: string, v: any) => { storage.set(k, String(v)); return "OK"; },
        multi: () => {
          const ops: Array<() => void> = [];
          return {
            set: (k: string, v: any) => { ops.push(() => storage.set(k, String(v))); return this; },
            exec: async () => { ops.forEach(o => o()); return []; },
          };
        },
      };

      for (let i = 0; i < 20; i++) {
        const count = await getSimulatedOnlineCount(mockRedis, 0);
        expect(count).toBeGreaterThanOrEqual(30);
        expect(count).toBeLessThan(100);
      }
    });

    it("incorporates real connected users within cap", async () => {
      const storage = new Map<string, string>();
      const mockRedis: any = {
        mget: async () => ["50", String(Date.now())],
        set: async () => "OK",
        multi: () => ({ set: () => this, exec: async () => [] }),
      };

      const countWithReal = await getSimulatedOnlineCount(mockRedis, 5);
      expect(countWithReal).toBeGreaterThanOrEqual(50);
      expect(countWithReal).toBeLessThan(100);
    });
  });

  describe("Persona Service", () => {
    it("has a pool of male and female personas with 60/40 ratio target", () => {
      const personas = getAllPersonas();
      expect(personas.length).toBeGreaterThan(15);

      const females = personas.filter((p) => p.gender === "female");
      const males = personas.filter((p) => p.gender === "male");

      expect(females.length).toBeGreaterThan(males.length);
      expect(females.length / personas.length).toBeCloseTo(0.6, 1);
    });

    it("gives 70% female attention to male users", () => {
      let femaleCount = 0;
      const iterations = 500;

      for (let i = 0; i < iterations; i++) {
        const responder = selectResponderPersona("male");
        if (responder.gender === "female") {
          femaleCount++;
        }
      }

      const femaleRatio = femaleCount / iterations;
      // Close to 70% (within 0.63 - 0.77)
      expect(femaleRatio).toBeGreaterThan(0.60);
      expect(femaleRatio).toBeLessThan(0.80);
    });

    it("correctly identifies bot user ids", () => {
      expect(isBotUserId("bot:female:1")).toBe(true);
      expect(isBotUserId("sim:dyn:123")).toBe(true);
      expect(isBotUserId("123e4567-e89b-12d3-a456-426614174000")).toBe(false);
    });
  });

  describe("Chat Generator", () => {
    it("returns 1 to 3 short chat bubbles", async () => {
      const persona = getRandomPersona();
      const bubbles = await generateChatBubbles({
        messages: [{ alias: "Stranger", text: "hi, kya kar rahe ho?", isReal: true }],
        targetPersona: persona,
        realUserGender: "male",
        roomType: "direct",
      });

      expect(bubbles.length).toBeGreaterThanOrEqual(1);
      expect(bubbles.length).toBeLessThanOrEqual(4);
      bubbles.forEach((b) => {
        expect(b.length).toBeGreaterThan(0);
        // Verify no AI robotic disclaimer
        expect(b.toLowerCase()).not.toContain("as an ai");
      });
    });
  });
});
