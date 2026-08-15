import { Config } from "../config.js";
import { InteraktClient } from "../wa/interakt.client.js";
import { WaSessionsRepo } from "../wa/wa-sessions.repo.js";
import { Contact } from "./campaigns.repo.js";
import { CampaignAttempt, CampaignAttemptsRepo } from "./campaign-attempts.repo.js";

export type CampaignSender = {
  sendLeg1(attempt: CampaignAttempt, contact: Contact): Promise<void>;
  sendDocRequest(contact: Contact, uploadUrl?: string): Promise<void>;
  sendText(phoneDigits: string, text: string): Promise<void>;
};

// Buttons are the same `verb:uuid` grammar the driver flow uses, so the existing
// payload-id → title → newest-live attribution ladder resolves them unchanged.
export function leg1Buttons(attemptId: string) {
  return [
    { id: `c1y:${attemptId}`, title: "1 Yes, send doc" },
    { id: `c1n:${attemptId}`, title: "2 Not interested" },
  ];
}

export function buildCampaignSender(deps: {
  interakt: InteraktClient;
  attempts: CampaignAttemptsRepo;
  sessions: WaSessionsRepo;
  config: Config;
}): CampaignSender {
  return {
    // Business-initiated, so the approved template is the expected path; the free
    // session send is tried first because it costs nothing when the contact
    // happens to be inside the 24h window (same shape as wa-sender.sendOffer).
    async sendLeg1(attempt, contact) {
      const to = contact.phoneDigits;
      const buttons = leg1Buttons(attempt.id);
      try {
        await deps.interakt.sendButtons(
          to,
          `${deps.config.companyName} — document verification\nHello ${contact.name}! We need your document to complete your registration.\nReply 1 to send it, or 2 if you're not interested.`,
          buttons,
        );
      } catch {
        await deps.interakt.sendTemplate(
          to,
          deps.config.campaignTemplate,
          [contact.name],
          Object.fromEntries(buttons.map((b, i) => [String(i), [b.id]])),
        );
        // The approved template's button labels are static, so remember those
        // exact titles — Interakt echoes title-only for template taps.
        buttons[0].title = "Yes, submit document";
        buttons[1].title = "Not interested";
      }
      await deps.attempts.setStatus(attempt.id, "IN_PROGRESS");
      await deps.attempts.setProviderRef(attempt.id, `wa_${attempt.id}`);
      await deps.sessions.upsert({
        phone: to,
        role: "campaign",
        state: "L1_OFFERED",
        ctx: { campaignAttemptId: attempt.id, contactId: contact.id },
        lastOptions: buttons,
      });
    },

    // After "1": ask for the photo, and include the upload link when configured.
    async sendDocRequest(contact, uploadUrl) {
      const link = uploadUrl ? `\n\nPrefer a browser? Upload here: ${uploadUrl}` : "";
      try {
        await deps.interakt.sendText(
          contact.phoneDigits,
          `Great, ${contact.name}! Please send a photo of your document (Aadhaar or identity proof) right here in this chat.${link}`,
        );
      } catch {
        /* best-effort — the stage already moved, a missed nudge is recoverable */
      }
    },

    async sendText(phoneDigits, text) {
      try {
        await deps.interakt.sendText(phoneDigits, text);
      } catch {
        /* best-effort */
      }
    },
  };
}
