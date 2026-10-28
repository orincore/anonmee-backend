import Together from "together-ai";
import { env } from "../../config/env";
import type { SimulationMessageContext } from "./simulation.types";

let togetherClient: Together | null = null;

function getClient(): Together | null {
  if (!togetherClient && env.TOGETHER_API_KEY) {
    togetherClient = new Together({ apiKey: env.TOGETHER_API_KEY });
  }
  return togetherClient;
}

// Fallback authentic Hinglish responses for resilience
const FALLBACK_HINGLISH_OPENERS = [
  ["hie", "kya chal raha h?"],
  ["hey", "kuch interesting batao yaar"],
  ["haye", "itni raat ko jag rahe ho?", "neend nahi aa rahi kya? haha"],
  ["hello ji :)", "kaha se ho waise?"],
  ["arre finally match mila haha", "kya kar rahe the?"],
  ["hiee :)", "bore ho rahi thi socha yaha chat karu"],
  ["hey", "kaise ho?", "kuch batao apne baare me"],
];

const FALLBACK_HINGLISH_GLOBAL = [
  "koi movie suggest karo yaar bore ho rahe",
  "aaj ka din bohot thakau tha sach me",
  "chai lovers attendance lagao ☕",
  "delhi me kya mast mausam ho raha h aaj",
  "neend kyu nahi aati yaar time pe kabhi haha",
  "spotify pe kuch naya sunte ho kya?",
  "weekend kab aayega bhagwan 😭",
  "sach me yaar, relatable baat boli tumne",
  "haha true that!",
  "arre aisa kya? mujhe to pata hi nahi tha",
  "kisi ko cold coffee pasand h yaha?",
  "late night talks hit differently na",
  "koi acha gaana batao mood fresh karne ke liye",
  "haye kitne inactive ho sab, kuch to bolo!",
  "sahi me bhai, same feeling",
];

const FALLBACK_HINGLISH_REPLIES_MALE = [
  ["arre sach me? haha", "tum bohot funny ho waise"],
  ["acha ji? aisa kya 😏", "aur batao apne baare me kuch"],
  ["haye", "itne sweet kyu ban rahe ho? haha"],
  ["waise konsi city se ho tum?", "mujhe guess karne do"],
  ["sahi baat h yaar", "mujhe bhi same lagta h bilkul"],
  ["haha cutie ho tum to", "kya karte ho waise study ya job?"],
  ["hmmm interesting", "phir aage kya hua? sunao na"],
];

const FALLBACK_HINGLISH_REPLIES_GENERAL = [
  ["haha sahi baat h", "main bhi yahi soch rahi thi"],
  ["arre yaar seriously?", "mujhe vishwas nahi ho raha haha"],
  ["sach me?", "aur batao kya chal raha hai"],
  ["sahi me bhai, bilkul relatable hai ye to"],
  ["haha lol", "aaj kal sab bore hi ho rahe hain lagta h"],
];

export async function generateChatBubbles(context: SimulationMessageContext): Promise<string[]> {
  const client = getClient();
  const persona = context.targetPersona;
  const isMaleUser = context.realUserGender === "male";
  const isFemalePersona = persona.gender === "female";

  if (!client || !env.TOGETHER_API_KEY) {
    return getFallbackBubbles(context);
  }

  try {
    const historyText = context.messages
      .slice(-6)
      .map((m) => `${m.alias}: ${m.text}`)
      .join("\n");

    const promptInstructions = `
You are a real 21-24 year old Indian young adult chatting anonymously on a cool mobile social app (Anonmee).
You are: ${persona.gender}, age ${persona.age}, casual, sweet, ${persona.vibe}.

CRITICAL RULES:
1. LANGUAGE: Hinglish (Hindi written in English alphabet, e.g. "kya kar rahe ho?", "sach me? haha", "arre yaar bore ho raha tha", "haye", "kaise ho?", "kaha se ho?").
2. NEVER mention any names or aliases! Everyone is completely anonymous stranger. Do NOT say "Hey [Name]" or "Quiet Fox". Just start talking like a real stranger on chat ("hey", "haye", "arre", "haha", "suno na").
3. NO AI MANNERISMS: No bullet points, no formal English, no lists, no "As an AI", no perfect long essays.
4. TONE:
   ${isMaleUser && isFemalePersona ? "- You are chatting with a male user. Be charming, sweet, playful, slightly flirty, warm, and engaging!" : "- Be friendly, playful, witty, and cooperative."}
5. FORMAT: Return 1, 2, or 3 SHORT chat lines (bubbles) separated by newlines.
   Each line should be a single short message bubble (1-8 words each), just like real humans send multiple quick texts!
   Do NOT put quotes or numbering or prefixes. Just the raw short message lines.

Example 1:
haye haha
sach me aisa hua kya?
phir kya kiya tumne?

Example 2:
arre yaar
mujhe bhi yahi laga tha bilkul
waise kaha se ho?

Recent conversation:
${historyText || "No previous messages yet. Send a friendly natural opening."}

Reply now in 1 to 3 short Hinglish text lines:
`.trim();

    const response = await client.chat.completions.create({
      model: env.TOGETHER_MODEL || "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      messages: [
        {
          role: "user",
          content: promptInstructions,
        },
      ],
      max_tokens: 150,
      temperature: 0.85,
    });

    const raw = response.choices?.[0]?.message?.content?.trim();
    if (!raw) return getFallbackBubbles(context);

    // Clean and split lines into distinct bubbles
    const lines = raw
      .split("\n")
      .map((l) => l.trim().replace(/^[-*•\d.)\]]\s*/, "").replace(/^["']|["']$/g, ""))
      .filter((l) => l.length > 0 && !l.toLowerCase().includes("as an ai"));

    if (lines.length === 0) return getFallbackBubbles(context);

    // Limit to 1 to 3 bubbles
    return lines.slice(0, 3);
  } catch (error) {
    console.error("Together AI chat completion error:", error);
    return getFallbackBubbles(context);
  }
}

function getFallbackBubbles(context: SimulationMessageContext): string[] {
  const isMaleUser = context.realUserGender === "male";
  const isFemalePersona = context.targetPersona.gender === "female";

  if (context.messages.length === 0) {
    const list = FALLBACK_HINGLISH_OPENERS;
    return list[Math.floor(Math.random() * list.length)]!;
  }

  if (context.roomType === "global") {
    if (context.messages.some((m) => m.isReal)) {
      if (isMaleUser && isFemalePersona) {
        return FALLBACK_HINGLISH_REPLIES_MALE[Math.floor(Math.random() * FALLBACK_HINGLISH_REPLIES_MALE.length)]!;
      }
      return FALLBACK_HINGLISH_REPLIES_GENERAL[Math.floor(Math.random() * FALLBACK_HINGLISH_REPLIES_GENERAL.length)]!;
    }
    const single = FALLBACK_HINGLISH_GLOBAL[Math.floor(Math.random() * FALLBACK_HINGLISH_GLOBAL.length)]!;
    return [single];
  }

  if (isMaleUser && isFemalePersona) {
    return FALLBACK_HINGLISH_REPLIES_MALE[Math.floor(Math.random() * FALLBACK_HINGLISH_REPLIES_MALE.length)]!;
  }

  return FALLBACK_HINGLISH_REPLIES_GENERAL[Math.floor(Math.random() * FALLBACK_HINGLISH_REPLIES_GENERAL.length)]!;
}
