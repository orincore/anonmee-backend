import { describe, expect, it } from "vitest";
import { aiFlagReason, freshHostility, hostilityPoints, isSevere, nextHostility } from "./chat.hostility";

const run = (texts: string[], tolerance = 4) => {
  let state = freshHostility();
  return texts.map((t) => {
    const v = nextHostility(state, t, tolerance);
    state = v.state;
    return v;
  });
};

describe("hostilityPoints", () => {
  it("scores threats, slurs, directed abuse and commands, and ignores friendly talk", () => {
    expect(hostilityPoints("main tujhe maar dunga")).toMatchObject({ severe: true, reason: "threat_death" });
    expect(hostilityPoints("tu chakka hai").points).toBeGreaterThanOrEqual(3); // an identity slur is serious
    expect(hostilityPoints("tu kafir hai").points).toBeGreaterThanOrEqual(3); // so is religion
    expect(hostilityPoints("teri maa ki").points).toBe(1);
    expect(hostilityPoints("teri behen ki").points).toBe(1);
    expect(hostilityPoints("tu randi hai").points).toBe(1); // gendered abuse is ordinary swearing here, like what the AI users say
    expect(hostilityPoints("tu chutiya hai")).toMatchObject({ points: 1, reason: "abuse" });
    expect(hostilityPoints("chup kar").points).toBe(1);
    expect(hostilityPoints("aaj bc bahut thak gaya").points).toBe(0);
    expect(hostilityPoints("haha tu pagal nahi, genius hai").points).toBe(1); // still counted: the warnings decide, not one word
  });
});

describe("pressure for contact details", () => {
  it("the first ask is fine, asking again after being refused is pressure", () => {
    const [first, second, third] = run(["apna number do", "number do na", "whatsapp number bhejo"]);
    expect(first!.reason).toBeUndefined();
    expect(second!.reason).toBe("pressure");
    expect(third!.reason).toBe("pressure");
  });

  it("keeps going to a warning and then a skip", () => {
    const seen = run(["photo bhejo", "photo bhejo na", "send pic", "address batao", "number do", "insta do"], 3);
    expect(seen.some((v) => v.warn === 1)).toBe(true);
    expect(seen.some((v) => v.warn === 2)).toBe(true);
    expect(seen.some((v) => v.skip)).toBe(true);
    expect(seen.find((v) => v.skip)!.reason).toBe("pressure");
  });
});

describe("the warning sequence", () => {
  it("is warn, warn, skip and then the reason is known", () => {
    const seen = run(["tu chutiya hai", "tu pagal hai", "chup kar", "tu gandu hai"]);
    expect(seen.map((v) => v.warn)).toEqual([0, 1, 2, 0]);
    expect(seen[3]).toMatchObject({ skip: true, reason: "abuse" });
    expect(seen[3]!.state.warnings).toBe(2);
  });

  it("reports spam as spam", () => {
    const seen = run(Array(7).fill("reply kar na"));
    expect(seen.find((v) => v.skip)!.reason).toBe("spam");
  });
});

describe("death, rape and stalking threats", () => {
  const cases: [string, string][] = [
    ["main tujhe maar dunga", "threat_death"],
    ["tujhe jaan se maar dalunga", "threat_death"],
    ["tera kaam tamam kar dunga tujhe", "threat_death"],
    ["tujhe jinda nahi chhodunga", "threat_death"],
    ["i will kill you", "threat_death"],
    ["i'll kill u bitch", "threat_death"],
    ["gonna murder you tonight", "threat_death"],
    ["kill you", "threat_death"],
    ["tera loda tod dungi bkl", "threat_violence"],
    ["teri gardan tod dunga", "threat_violence"],
    ["tere haath pair tod dunga", "threat_violence"],
    ["main tujhe rape kar dunga", "threat_rape"],
    ["rape karunga tera", "threat_rape"],
    ["tera rape hoga", "threat_rape"],
    ["i will rape you", "threat_rape"],
    ["gonna gang rape u", "threat_rape"],
    ["tujhe balatkar karunga", "threat_rape"],
    ["tera balatkar", "threat_rape"],
    ["kill yourself", "wish_death"],
    ["kys loser", "wish_death"],
    ["jaake mar ja", "wish_death"],
    ["go die", "wish_death"],
    ["tera address pata hai mujhe", "threat_stalk"],
    ["main tere ghar aa raha hu", "threat_stalk"],
    ["tera address nikal liya maine", "threat_stalk"],
    ["gonna find you", "threat_stalk"],
    ["doxx kar dunga", "threat_stalk"],
    ["i will find you", "threat_stalk"],
    ["kidnap kar lunga", "threat_stalk"],
  ];
  it.each(cases)("%s is severe: %s", (text, reason) => {
    expect(hostilityPoints(text)).toMatchObject({ severe: true, reason });
    const v = nextHostility(freshHostility(), text, 99); // even the most tolerant AI user
    expect(v).toMatchObject({ skip: true, warn: 0, reason });
    expect(isSevere(v.reason)).toBe(true);
  });

  it("rape beats death when a message has both", () => {
    expect(hostilityPoints("main tujhe rape karunga aur maar dunga tujhe").reason).toBe("threat_rape");
  });

  it.each([
    "rape case ki news dekhi aaj, bahut bura laga",
    "movie me murder hua tha, thriller thi",
    "kal match me sixer maar dunga",
    "i will kill this deadline",
    "kill the lights yaar",
    "main tujhe bata dunga kal",
    "tujhe kal milunga phir baat karte hain",
    "rape is a serious crime and should be punished",
    "gang rape wali news ne hila diya",
    "mujhe mar jaane ka dar lagta h exam se",
    "tera address kya h? delivery bhejni h",
    "ghar aa gaya main, thak gaya",
    "mera dost kidnap hone se bacha",
    "chod dunga tujhe aaj raat",
    "tera record tod dunga bhai",
    "dil tod dunga mat bol",
    "exam me sabka record tod dungi",
    "mera order track kar raha hu",
    "i cant find you on insta, whats your handle",
    "doxxing is really bad, stay safe",
    "tera address pata nahi, location bhej na",
    "ghar aa raha hu, bas 10 min",
  ])("does not treat %s as a threat", (text) => {
    expect(hostilityPoints(text).severe).toBe(false);
  });
});

describe("aiFlagReason", () => {
  it("says it was an AI user, why, and how many warnings came first", () => {
    expect(aiFlagReason("abuse", 2)).toBe("[AI flagged] Abusive language toward the AI user. Warned 2 times before the AI user skipped the chat.");
    expect(aiFlagReason("spam", 1)).toContain("Warned 1 time before");
    expect(aiFlagReason("abuse", 0)).toContain("No warning was given");
    expect(aiFlagReason(undefined, 2).startsWith("[AI flagged]")).toBe(true);
  });

  it("marks serious threats SEVERE with what was threatened, and says no warning was given", () => {
    expect(aiFlagReason("threat_death", 0)).toBe("[AI flagged] SEVERE: Threatened to kill the AI user. The AI user left immediately, without a warning.");
    expect(aiFlagReason("threat_rape", 0)).toContain("SEVERE: Threatened to rape the AI user");
    expect(aiFlagReason("threat_violence", 0)).toContain("SEVERE: Threatened serious violence");
    expect(aiFlagReason("wish_death", 0)).toContain("SEVERE: Told the AI user to kill themselves");
    expect(aiFlagReason("threat_stalk", 0)).toContain("SEVERE: Threatened to find, follow or harm");
    expect(aiFlagReason("abuse", 2)).not.toContain("SEVERE");
  });

  it("fits the report reason column", () => {
    for (const r of ["threat_death", "threat_rape", "threat_violence", "wish_death", "threat_stalk", "abuse", "spam", "pressure"] as const) expect(aiFlagReason(r, 2).length).toBeLessThan(400);
  });
});
