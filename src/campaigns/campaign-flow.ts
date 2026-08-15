import { Config } from "../config.js";
import { WaInbound } from "../wa/inbound.js";
import { Contact } from "./campaigns.repo.js";
import { ContactsRepo } from "./contacts.repo.js";
import { CampaignAttemptsRepo } from "./campaign-attempts.repo.js";
import { CampaignDocsRepo, CampaignEventsRepo } from "./campaign-docs.repo.js";
import { CampaignSender } from "./campaign-sender.js";
import { VisionClient } from "../wa/vision.js";

export type CampaignFlowDeps = {
  contacts: ContactsRepo;
  attempts: CampaignAttemptsRepo;
  docs: CampaignDocsRepo;
  events: CampaignEventsRepo;
  sender: CampaignSender;
  config: Config;
  vision?: VisionClient;
  // Builds the browser upload link for a contact (T5 mints the HMAC token).
  uploadUrl?: (contact: Contact) => string;
};

// A contact answers "1" (interested) or "2" (not interested) — as a button tap,
// a template button title, or plain text. Everything converges here so all three
// entry paths produce the same stage transition.
export async function handleCampaignMessage(
  deps: CampaignFlowDeps,
  m: WaInbound,
  contact: Contact,
): Promise<void> {
  const choice = readChoice(m);

  if (m.kind === "media" && m.mediaUrl) return recordWaDoc(deps, contact, m.mediaUrl);

  if (choice === "yes") return accept(deps, contact, m);
  if (choice === "no") return decline(deps, contact, m);

  // Anything else: re-state the two options rather than guessing.
  await deps.sender.sendText(
    contact.phoneDigits,
    `Sorry ${contact.name}, I didn't catch that. Reply 1 to send your document, or 2 if you're not interested.`,
  );
}

// "1"/"2" can arrive as our payload id, the button title, or free text.
export function readChoice(m: WaInbound): "yes" | "no" | null {
  const verb = m.replyId?.split(":")[0];
  if (verb === "c1y") return "yes";
  if (verb === "c1n") return "no";

  const text = `${m.text ?? ""} ${m.replyTitle ?? ""}`.toLowerCase();
  if (/(^|\D)1(\D|$)|\byes\b|\binterested\b|\bhaan\b|\bha\b/.test(text) && !/not interested/.test(text)) {
    return "yes";
  }
  if (/(^|\D)2(\D|$)|\bno\b|\bnot interested\b|\bnahi\b/.test(text)) return "no";
  return null;
}

async function accept(deps: CampaignFlowDeps, contact: Contact, m: WaInbound) {
  await closeLiveLeg1(deps, contact.id);
  await deps.contacts.setStage(contact.id, "L1_INTERESTED");
  await deps.events.log(contact.id, "wa_reply", { leg: 1, detail: { choice: "1" } });
  await deps.sender.sendDocRequest(contact, deps.uploadUrl?.(contact));
  void m;
}

async function decline(deps: CampaignFlowDeps, contact: Contact, m: WaInbound) {
  await closeLiveLeg1(deps, contact.id);
  // L1_DECLINED is exactly the set leg 2 dials — nothing else may enter it.
  await deps.contacts.setStage(contact.id, "L1_DECLINED");
  await deps.events.log(contact.id, "wa_reply", { leg: 1, detail: { choice: "2" } });
  await deps.sender.sendText(
    contact.phoneDigits,
    `Understood ${contact.name}. We've updated your status. If you change your mind, reply anytime!`,
  );
  void m;
}

async function closeLiveLeg1(deps: CampaignFlowDeps, contactId: string) {
  const live = await deps.attempts.findLive(contactId, 1);
  if (live) await deps.attempts.setStatus(live.id, "DONE", { ended: true });
}

// A photo in the chat. Extraction is best-effort: an unreadable document is
// still stored so a human can look at it, mirroring the driver doc pipeline.
export async function recordWaDoc(deps: CampaignFlowDeps, contact: Contact, mediaUrl: string) {
  let extracted: Record<string, unknown> = {};
  if (deps.vision) {
    const res = await deps.vision.extract(mediaUrl);
    extracted = res.ok ? (res as unknown as Record<string, unknown>) : { ok: false, reason: (res as any).reason };
  }
  await deps.docs.create({ contactId: contact.id, source: "wa", mediaUrl, extracted });
  await deps.contacts.setStage(contact.id, "DOC_RECEIVED");
  await deps.events.log(contact.id, "doc_received", { leg: 1, detail: { source: "wa" } });
  await deps.sender.sendText(
    contact.phoneDigits,
    `Got it, ${contact.name} — document received. We'll verify it and get back to you. Thank you! 🙏`,
  );
}
