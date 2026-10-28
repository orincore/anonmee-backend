import { describe, expect, it } from "vitest";
import { addressHint, formsHint, formsMismatch, formsOf } from "./chat.gender";

describe("formsOf", () => {
  it("maps each gender to the Hindi verb forms that fit", () => {
    expect(formsOf("female")).toBe("feminine");
    expect(formsOf("trans_woman")).toBe("feminine");
    expect(formsOf("male")).toBe("masculine");
    expect(formsOf("trans_man")).toBe("masculine");
    expect(formsOf("non_binary")).toBe("neutral");
    expect(formsOf("prefer_not_to_say")).toBe("neutral");
  });
});

describe("formsMismatch", () => {
  it.each([
    ["main thak gayi aaj", "female", false],
    ["main thak gaya aaj", "female", true],
    ["tumhe dekhke so nahi pa rahi hu", "trans_woman", false],
    ["tumhe dekhke so nahi pa raha hu", "trans_woman", true],
    ["main tumse milna chahta hu", "male", false],
    ["main tumse milna chahti hu", "male", true],
    ["bed pe leta hua hu", "female", true],
    ["bed pe leti hui hu", "female", false],
    ["bed pe leti hui hu", "male", true],
    ["samajh gayi ki kya hua", "female", false],
    ["kya kar rahi hu bc", "trans_man", true],
    ["boring lagunga kya", "female", true],
    ["boring lagungi kya", "female", false],
    ["main bataunga", "female", true],
    ["main bataungi", "female", false],
    ["tujhe sab sikha dungi", "male", true],
    ["tujhe sab sikha dunga", "male", false],
    ["kal milunga", "trans_woman", true],
    ["kal milungi", "non_binary", true],
    ["wo kal aayega", "female", false],
    ["kya kar raha hu bc", "trans_man", false],
  ] as const)("%s as %s -> mismatch %s", (text, gender, expected) => {
    expect(formsMismatch(text, gender)).toBe(expected);
  });

  it("does not punish talking about, or to, someone else", () => {
    expect(formsMismatch("tum kahan gayi thi kal", "male")).toBe(false);
    expect(formsMismatch("wo aaya tha party me", "female")).toBe(false);
    expect(formsMismatch("usne kaha wo aa rahi h", "male")).toBe(false);
  });

  it("non-binary and undeclared personas avoid both gendered forms, but may use neutral phrasing", () => {
    expect(formsMismatch("main thak gaya", "non_binary")).toBe(true);
    expect(formsMismatch("main thak gayi", "prefer_not_to_say")).toBe(true);
    expect(formsMismatch("yahi soch raha hu", "non_binary")).toBe(true);
    expect(formsMismatch("mujhe neend aa rahi h, bore ho gaya", "non_binary")).toBe(false);
  });
});

describe("hints", () => {
  it("tell the model how to talk about itself and to the other person", () => {
    expect(formsHint("female")).toMatch(/feminine/);
    expect(formsHint("male")).toMatch(/masculine/);
    expect(formsHint("non_binary")).toMatch(/Never use gendered verb forms/);
    expect(addressHint("female")).toMatch(/woman/);
    expect(addressHint("male")).toMatch(/man/);
  });
});
