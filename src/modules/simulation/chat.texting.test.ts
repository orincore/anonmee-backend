import { describe, expect, it } from "vitest";
import { degradeSpelling, isBookish, isCliche, isCoyStall, noDashes, spellingIntensity } from "./chat.texting";

const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

describe("degradeSpelling", () => {
  it("leaves the text alone at zero", () => {
    expect(degradeSpelling("mujhe nahi pata kya kar raha hai", 0)).toBe("mujhe nahi pata kya kar raha hai");
  });

  it("types the way people type when lazy: nhi, h, kr, rha, mjhe", () => {
    const out = degradeSpelling("mujhe nahi pata kya kar raha hai", 1, () => 0);
    expect(out).toBe("mjhe nhi pata kya kr rha h");
  });

  it("is not the same every time, and never touches words it does not know", () => {
    const seen = new Set(Array.from({ length: 60 }, (_, i) => degradeSpelling("mujhe bahut neend aa rahi hai yaar", 0.6, seeded(i + 1))));
    expect(seen.size).toBeGreaterThan(8);
    for (const s of seen) expect(s).toContain("neend aa");
  });

  it("mixes shortened and full words, as real typing does", () => {
    let hits = 0;
    for (let i = 1; i <= 200; i++) {
      const out = degradeSpelling("kya kar raha hai tu", 0.5, seeded(i));
      if (/kr/.test(out) && /\bhai\b/.test(out)) hits++;
    }
    expect(hits).toBeGreaterThan(10);
  });

  it("shortens English the way chat does", () => {
    expect(degradeSpelling("please tell me because you are late", 1, () => 0)).toBe("pls tell me coz u r late");
  });

  it("keeps a capital letter and never returns an empty line", () => {
    expect(degradeSpelling("Nahi yaar", 1, () => 0)).toBe("Nhi yaar");
    for (let i = 1; i <= 100; i++) expect(degradeSpelling("hai", 1, seeded(i)).length).toBeGreaterThan(0);
  });

  it("stretches an ending now and then", () => {
    let stretched = 0;
    const rng = seeded(7); // one stream: consecutive seeds start almost identically
    for (let i = 1; i <= 400; i++) if (/yaarr+|bhaii+|plss+/i.test(degradeSpelling("sahi baat yaar", 1, rng))) stretched++;
    expect(stretched).toBeGreaterThan(10);
  });

  it("keeps emojis and numbers", () => {
    expect(degradeSpelling("kya hai 😂 2 baje", 1, () => 0)).toContain("😂");
    expect(degradeSpelling("kya hai 😂 2 baje", 1, () => 0)).toContain("2 baje");
  });
});

describe("spellingIntensity", () => {
  it("lazy typists shorten almost everything, careful ones little", () => {
    expect(spellingIntensity("types fast and lazy: fragments, no punctuation")).toBeGreaterThan(spellingIntensity("clean full sentences in Hinglish, a bit sarcastic"));
    expect(spellingIntensity("rowdy: swears in almost every message")).toBeGreaterThan(spellingIntensity("sweet and polite, never swears"));
  });
});

describe("isBookish", () => {
  it.each(["kripya mujhe uttar dijiye", "aapka vichaar acha hai mitra", "dhanyavaad", "shubh ratri mitro", "mujhe aapse sambandh banana hai"])("flags %s", (t) =>
    expect(isBookish(t)).toBe(true));

  it.each(["bc kya scene h", "yaar mujhe neend aa rhi", "timepass kr rha hu bro", "teri maa ki, kya bakwaas kr rha h", "aaj ka din bht bura tha", "thanks bhai 😂"])(
    "leaves %s alone",
    (t) => expect(isBookish(t)).toBe(false),
  );
});

describe("noDashes", () => {
  const DASH = /[\u2012\u2013\u2014\u2015\u2212]/;

  it.each([
    ["wait \u2014 kya hua", "wait, kya hua"],
    ["wait\u2014kya hua", "wait, kya hua"],
    ["sahi h \u2013 par thoda late", "sahi h, par thoda late"],
    ["arre \u2014\u2014 sun na", "arre, sun na"],
    ["\u2014 haan yaar", "haan yaar"],
    ["haan yaar \u2014", "haan yaar"],
    ["ruk \u2014, kya bola", "ruk, kya bola"],
  ])("%s -> %s", (input, out) => {
    expect(noDashes(input)).toBe(out);
    expect(DASH.test(noDashes(input))).toBe(false);
  });

  it("keeps a range readable: a dash between numbers becomes a hyphen", () => {
    expect(noDashes("10\u201315 min lagenge")).toBe("10-15 min lagenge");
    expect(noDashes("2 \u2014 3 baje")).toBe("2-3 baje");
  });

  it("leaves ordinary hyphens, ellipses and text alone", () => {
    for (const t of ["x-ray kra", "kya baat h...", "e-mail bhej", "same \u{1F62D}", "hmm\u2026 ok"]) expect(noDashes(t)).toBe(t);
  });

  it("removes every kind of long dash, whatever mix the model uses", () => {
    const messy = "a\u2012b\u2013c\u2014d\u2015e\u2212f \u2014\u2013\u2014 g";
    expect(DASH.test(noDashes(messy))).toBe(false);
  });
});

describe("isCliche", () => {
  it.each([
    "tu line cross mat kar", "usne line maar di", "line mat maar mujhpe", "bhai line cross ho gayi", "line dena band kar", "tu line pe aa jaa",
    "limit cross kr rha h tu", "hadd cross mat kar", "ye to next level h", "vibe check krte h", "ye red flag h", "tension mat le yaar", "green flag h ladka",
  ])("flags %s", (t) => expect(isCliche(t)).toBe(true));

  it.each([
    "line me khada hu 2 ghante se", "online aaja", "phone ki line busy h", "mera lineup kaisa h", "pehli line padh", "kal ka match dekha", "boss ne daant diya", "tu bol kya scene h",
    "red wali shirt pehni h", "next week milte h", "level badh gaya game me",
  ])("leaves %s alone", (t) => expect(isCliche(t)).toBe(false));
});

describe("isCoyStall", () => {
  it.each([
    // lines from a real chat that went nowhere
    "Ekdm seedha point pe aaye tum, me to ekdum se hil gayi",
    "bolo pehle, itni himmat kaha se laaye?",
    "Bataungi bataungi, itni jldiii kya h, pehle thoda to warm up karne do na 😏",
    "seedha sawaal, bina baat cheet ke. Missionary theek lagti h",
    "pehle ye bata, tu mujhse pooch raha h ya apne liye list bana rha h?",
    "Itni jaldi? pehle apni pasand bta, phir sochti hu",
    "bc seedha hi pooch liya 💀 pehle thoda flirt toh kr",
    "Nhi bataungi, itna asaan nhi h. Thoda effort dalo",
    "abe 😭 itna jaldi kyaa h, pehle ye bata tu itna direct kyu h",
    "match hote hi seedha aise messages, sharm se laal ho jaati hu 😳",
    "arre bas bas 🙈 ab aise bolega to sharma jaungi",
    "seedha seedha point pe aa gaye",
  ])("flags: %s", (t) => expect(isCoyStall(t)).toBe(true));

  it.each([
    "doggy, no contest 😅 tu bta apna",
    "mujhe jahan control mere haath me ho 😌 tu bata, tu dominate krta h ya follow?",
    "slow start, phir speed badhana. teri taraf se kya chahiye",
    "t-shirt aur shorts, bas. tu bata, tune kya pehna h?",
    "haan, 8 mahine se single hu. tu?",
    "seedha ghar ja, raat ho gayi h",
    "pehle chai pi le phir baat krte h",
    "bata na kya hua tha",
  ])("lets through: %s", (t) => expect(isCoyStall(t)).toBe(false));
});
