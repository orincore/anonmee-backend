import type { ChatMessage, Gender } from "../../contracts";
import { planCrowd } from "./chat.crowd";
import { isSexualTalk, wantsStop } from "./chat.safety";
import type { RoomScriptHost } from "./script.runner";
import { generateChatBubbles } from "./together.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The held topic, unless it is just the message being answered (then there is nothing extra to say). */
const topicOf = (held: string | null | undefined, current: string) => (held && held.trim() !== current.trim() ? held : undefined);
const ENGAGED_WINDOW_MS = 90_000;

/**
 * A real person spoke in a shared room: several personas answer one after another, each with its own
 * attitude (flirty, cold, roasting, curious, steering elsewhere). Each sees what the earlier ones wrote and
 * sometimes answers them instead of the person, so it reads as a room with mixed opinions.
 * `isCurrent` turns false when the person speaks again, which drops the replies that are now stale.
 */
export async function respondAsCrowd(args: {
  host: RoomScriptHost;
  roomType: "global" | "group";
  message: ChatMessage;
  userGender?: Gender;
  isCurrent: () => boolean;
}) {
  const { host, roomType, message, userGender, isCurrent } = args;
  const [pool, before] = await Promise.all([host.pool(), host.history()]);
  const followUp = before.some((m) => m.id !== message.id && m.alias === message.alias && Date.now() - m.at < ENGAGED_WINDOW_MS);
  const plan = planCrowd(
    pool,
    { userGender, exclude: [message.alias], recentAliases: before.slice(-3).map((m) => m.alias), followUp, calm: wantsStop(message.text), heated: isSexualTalk(message.text), messageLength: message.text.length },
  );

  let lastBot: ChatMessage | null = null;
  let lastStance: string | null = null;
  for (const step of plan) {
    await sleep(step.delayMs);
    if (!isCurrent()) return;

    const recent = await host.history();
    if (!recent.some((m) => m.id === message.id)) recent.push(message);
    // Sometimes answer the persona who just spoke instead of the person, which makes the room feel alive.
    // Supporters often answer whoever just roasted or brushed the person off; others sometimes reply to the last speaker.
    const roasted = lastStance === "roast" || lastStance === "cold";
    const target = lastBot && (step.stance === "support" && roasted ? Math.random() < 0.7 : step.stance !== "curious" && Math.random() < 0.4) ? lastBot : message;

    const bubbles = await generateChatBubbles({
      messages: recent.map((m) => ({ alias: m.alias, gender: m.gender, age: m.age, text: m.text, at: m.at, isReal: !host.isPersonaAlias(m.alias) })),
      targetPersona: step.persona,
      realUserGender: target === message ? userGender : undefined, // addressing a persona, not the person
      roomType,
      roomKey: host.roomKey,
      groupTitle: host.groupTitle,
      replyTo: { alias: target.alias, text: target.text },
      roomTopic: topicOf(host.topic?.(), message.text),
      stance: step.stance,
    });
    if (bubbles.length === 0 || !isCurrent()) continue;

    const posted = await host.say(step.persona, bubbles[0]!, target !== message || step.quote ? target.id : undefined);
    if (posted) {
      lastBot = posted;
      lastStance = step.stance;
    }
    if (bubbles[1] && Math.random() < 0.4 && isCurrent()) {
      await sleep(700 + Math.random() * 900);
      const second = await host.say(step.persona, bubbles[1]);
      if (second) lastBot = second;
    }
  }
}
