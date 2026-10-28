import { describe, expect, it } from "vitest";
import { activeTopic, contentWords, HOLD_MS, isNewSubject, isSubstantive, updateTopic, type TopicHold } from "./topic.hold";

const T0 = 1_000_000;
const min = (n: number) => n * 60_000;

describe("what counts as a topic", () => {
  it("a greeting, a reaction or a few words is not", () => {
    for (const t of ["hii", "kaise ho", "lol sahi", "haan yaar 😂", "ok", "kya hua"]) expect(isSubstantive(t)).toBe(false);
  });

  it("a real statement or question is", () => {
    for (const t of ["boss ne aaj sabke saamne mujhe daant diya", "koi batao job chhodne ka sahi time kab hota h", "i think long distance relationships never work"])
      expect(isSubstantive(t)).toBe(true);
  });

  it("content words skip the fillers", () => {
    expect(contentWords("yaar mera boss bohot kya hai")).toEqual(["boss"]);
    expect(contentWords("office me stress bohot h")).toEqual(["office", "stress"]);
  });
});

describe("holding the topic", () => {
  const topic = "boss ne aaj sabke saamne mujhe daant diya office me";

  it("the first substantive message becomes the topic", () => {
    const h = updateTopic(null, topic, T0)!;
    expect(h.topic).toBe(topic);
    expect(h.startedAt).toBe(T0);
    expect(h.batches).toBe(0);
  });

  it("a greeting does not start one", () => {
    expect(updateTopic(null, "hii kaise ho", T0)).toBeNull();
  });

  it("follow-up messages keep the topic: reactions, questions, remarks never replace it", () => {
    let h = updateTopic(null, topic, T0);
    for (const [i, t] of ["haan yaar", "kya bola usne?", "mera boss bhi aisa hi h", "lol sach me", "phir kya kiya tumne", "ab kya karu", "sahi me bura laga"].entries()) {
      h = updateTopic(h, t, T0 + min(i + 1));
      expect(h!.topic).toBe(topic);
    }
    expect(h!.startedAt).toBe(T0);
  });

  it("keeps it for 15 minutes after the last time the person spoke about it", () => {
    const h = updateTopic(null, topic, T0)!;
    expect(activeTopic(h, T0 + min(14))).toBe(h);
    expect(activeTopic(h, T0 + HOLD_MS)).toBeNull();
    const again = updateTopic(h, "haan phir kya hua", T0 + min(10))!; // they are still on it, so the clock restarts
    expect(activeTopic(again, T0 + min(24))).toBe(again);
    expect(activeTopic(again, T0 + min(26))).toBeNull();
  });

  it("an expired topic is replaced by the next substantive message", () => {
    const h = updateTopic(null, topic, T0)!;
    const next = updateTopic(h, "kal ka match dekha kya, last over me kya hua tha", T0 + min(20))!;
    expect(next.topic).toContain("match");
    expect(next.startedAt).toBe(T0 + min(20));
  });

  it("changes only when the person clearly changes the subject", () => {
    const h = updateTopic(null, topic, T0)!;
    for (const shift of ["btw kal ka match dekha kya last over me kya hua tha", "waise ek baat batao tum log kitne bje sote ho roz", "anyway chhodo ye sab, koi movie suggest karo"]) {
      expect(isNewSubject(shift, h.topic)).toBe(true);
      const next = updateTopic(h, shift, T0 + min(2))!;
      expect(next.topic).toBe(shift);
      expect(next.batches).toBe(0);
    }
  });

  it("a long message about the same thing does not count as a new subject", () => {
    const long = "mera boss hamesha sabke saamne daant deta h aur ab main sochta hu ki office chhod du kyunki ye roz ka tamasha ho gya h";
    expect(isNewSubject(long, topic)).toBe(false);
  });

  it("a long message about nothing in common does", () => {
    const long = "kal raat mujhe ek bahut ajeeb sapna aaya jisme main train se gir gaya aur phir subah uthke bahut der tak soch raha tha";
    expect(isNewSubject(long, topic)).toBe(true);
  });

  it("a short remark never counts as a new subject, however unrelated", () => {
    expect(isNewSubject("pizza khane ka mann h", topic)).toBe(false);
  });

  it("keeps the person's own words, trimmed to a sensible length", () => {
    const long = "boss ".repeat(80);
    expect(updateTopic(null, long, T0)!.topic.length).toBeLessThanOrEqual(140);
  });
});

describe("activeTopic", () => {
  it("is null with nothing held", () => {
    expect(activeTopic(null, T0)).toBeNull();
    const h: TopicHold = { topic: "x y z w", startedAt: T0, lastMentionAt: T0, batches: 0 };
    expect(activeTopic(h, T0 + 1)).toBe(h);
  });
});
