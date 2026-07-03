import { WaOption } from "./interakt.client.js";

export type WaInbound = {
  from: string;
  msgId: string;
  kind: "reply" | "text";
  replyId?: string;
  replyTitle?: string;
  text?: string;
  contactName: string;
};

const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Interakt inbound → one normalized shape. Three ways a tap reaches us:
// (1) `message` is a JSON string {"type":"button_reply",...} carrying OUR id;
// (2) template button clicks arrive as message_api_clicked with button_text;
// (3) session replies sometimes echo just the tapped TITLE — resolve it against
//     the options we last sent (emoji/punctuation-insensitive), else free text.
export function parseInbound(payload: any, lastOptions: WaOption[]): WaInbound | null {
  const type = payload?.type;
  if (type !== "message_received" && type !== "message_api_clicked") return null;

  const customer = payload?.data?.customer ?? {};
  const msg = payload?.data?.message ?? {};
  const from: string = String(customer.channel_phone_number ?? "").replace(/\D/g, "");
  if (!from) return null;
  const msgId: string = msg.id || `${from}-${payload?.timestamp ?? ""}`;
  const contactName: string = customer?.traits?.name || "there";
  const base = { from, msgId, contactName };

  if (type === "message_api_clicked") {
    const title: string = msg.button_text || msg.button_payload?.payload?.text || "";
    const hit = lastOptions.find((o) => norm(o.title) === norm(title));
    return { ...base, kind: "reply", replyId: hit?.id ?? title, replyTitle: title };
  }

  const raw = typeof msg.message === "string" ? msg.message.trim() : "";
  if (raw.startsWith("{") && raw.includes("_reply")) {
    try {
      const parsed = JSON.parse(raw);
      const inner = parsed.list_reply || parsed.button_reply || parsed.reply;
      if (inner && (inner.id || inner.title)) {
        return { ...base, kind: "reply", replyId: String(inner.id ?? inner.title), replyTitle: String(inner.title ?? inner.id) };
      }
    } catch { /* not a JSON reply */ }
  }

  const needle = norm(raw);
  if (needle) {
    const hit = lastOptions.find((o) => norm(o.title) === needle);
    if (hit) return { ...base, kind: "reply", replyId: hit.id, replyTitle: raw };
  }
  return { ...base, kind: "text", text: raw };
}
