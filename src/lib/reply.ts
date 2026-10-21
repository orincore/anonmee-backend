import type { ChatMessage, ReplyPreview } from "../contracts";

const SNIPPET = 120;

/** The quote shown above a reply. Built on the server from the real message, never from what the client says. */
export function previewOf(m: Pick<ChatMessage, "id" | "alias" | "text">): ReplyPreview {
  return { id: m.id, alias: m.alias, text: m.text.length > SNIPPET ? `${m.text.slice(0, SNIPPET)}...` : m.text };
}
