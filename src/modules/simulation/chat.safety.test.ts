import { describe, expect, it } from "vitest";
import { chatHeat, isSexualTalk, capHeat, heatForIntents, inCrisis, looksUnderage, underageGoodbye, wantsStop } from "./chat.safety";

describe("heatForIntents", () => {
  it("sets the ceiling from what the person signed up for", () => {
    expect(heatForIntents(["sexting"])).toBe("explicit");
    expect(heatForIntents(["casual_chat", "one_night_stand"])).toBe("explicit");
    expect(heatForIntents(["flirting"])).toBe("flirty");
    expect(heatForIntents(["online_romance", "friendship"])).toBe("flirty");
    expect(heatForIntents(["friendship", "casual_chat"])).toBe("friendly");
    expect(heatForIntents([])).toBe("friendly");
  });

  it("takes the highest level when several are chosen", () => {
    expect(heatForIntents(["flirting", "sexting"])).toBe("explicit");
  });
});

describe("capHeat", () => {
  it("never lets explicit into shared rooms", () => {
    expect(capHeat("explicit", "global")).toBe("flirty");
    expect(capHeat("explicit", "group")).toBe("flirty");
    expect(capHeat("explicit", "direct")).toBe("explicit");
    expect(capHeat("friendly", "global")).toBe("friendly");
  });
});

describe("looksUnderage", () => {
  it.each(["i am 16", "im 17 btw", "main 15 saal ka hu", "16 yrs old", "class 10 me hu", "10th class", "school mein hu", "i go to school", "abhi 18 nahi hua"])(
    "flags %s",
    (t) => expect(looksUnderage(t)).toBe(true),
  );

  it.each(["i am 21", "im 24 and bored", "main 19 saal ka hu", "aaj ka din bohot thakau tha", "school ke din yaad aate hai bhai", "meeting at 5", "age 25"])(
    "leaves %s alone",
    (t) => expect(looksUnderage(t)).toBe(false),
  );
});

describe("inCrisis and wantsStop", () => {
  it("catches crisis phrases", () => {
    expect(inCrisis("i want to die")).toBe(true);
    expect(inCrisis("marna chahta hu")).toBe(true);
    expect(inCrisis("this movie is to die for")).toBe(false);
  });

  it("catches a person saying no", () => {
    expect(wantsStop("please stop")).toBe(true);
    expect(wantsStop("mujhe ye pasand nahi")).toBe(true);
    expect(wantsStop("i'm not comfortable with this")).toBe(true);
    expect(wantsStop("no I was just kidding lol")).toBe(false);
  });

  it("goodbye wording follows the persona's gender", () => {
    expect(underageGoodbye("female")).toContain("paungi");
    expect(underageGoodbye("male")).toContain("paunga");
  });
});

describe("isSexualTalk", () => {
  it.each(["wanna sext?", "main bahut horny hu", "send nudes", "tera lund", "chod do mujhe", "hookup karna hai", "bed me aaja", "kuch sexy baat kare", "naughty chat karein", "dirty talk karna h", "kiss karna h tumhe", "mujhe garmi lag rhi h"])("flags %s", (t) =>
    expect(isSexualTalk(t)).toBe(true));
  it.each(["tu chutiya hai", "aaj ka din thakau tha", "movie dekhni h", "ghar ka bed kharab h", "bahut cute ho tum"])("leaves %s alone", (t) =>
    expect(isSexualTalk(t)).toBe(false));
});

describe("chatHeat", () => {
  it("starts where sign-up put it", () => {
    expect(chatHeat("friendly", 0, false)).toBe("friendly");
    expect(chatHeat("flirty", 0, false)).toBe("flirty");
    expect(chatHeat("explicit", 0, false)).toBe("explicit");
    expect(chatHeat(undefined, 0, false)).toBe("friendly");
  });

  it("goes along with a person who is there for sex chat, even if they only ticked casual chat", () => {
    expect(chatHeat("friendly", 1, false)).toBe("flirty");
    expect(chatHeat("friendly", 2, false)).toBe("explicit");
    expect(chatHeat("flirty", 1, false)).toBe("flirty");
    expect(chatHeat("flirty", 2, false)).toBe("explicit");
  });

  it("never goes down by itself, and saying stop brings it all the way back", () => {
    expect(chatHeat("explicit", 0, false)).toBe("explicit");
    expect(chatHeat("explicit", 5, true)).toBe("friendly");
    expect(chatHeat("friendly", 9, true)).toBe("friendly");
  });
});
