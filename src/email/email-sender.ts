import { Config } from "../config.js";
import { Mailer } from "./mailer.js";
import { CallsRepo, CallAttempt, CallFlow } from "../calls/calls.repo.js";
import { Load } from "../loads/loads.schema.js";
import { Owner } from "../owners/owners.schema.js";
import { DemandRequest } from "../demand/demand.repo.js";
import { signAction, ActionToken } from "./tokens.js";
import { inr } from "../wa/wa-sender.js";

export type EmailSender = {
  sendOffer(attempt: CallAttempt, load: Load, owner: Owner, priceInr: number, flow: CallFlow): Promise<void>;
  sendConfirm(demand: DemandRequest, load: Load, ownerName: string): Promise<void>;
  sendFilled(email: string, load: Load): Promise<void>;
  notify(email: string, subject: string, text: string): Promise<void>;
};

export function buildEmailSender(deps: { mailer: Mailer; callsRepo: CallsRepo; config: Config }): EmailSender {
  const route = (load: Load) => `${load.fromLocation} → ${load.toLocation}`;
  const link = (a: ActionToken["a"], id: string, p?: number) =>
    `${deps.config.publicBaseUrl}/e/${a}?t=${signAction(deps.config.webhookSecret, { a, id, p })}`;

  return {
    // Magic-link offer. Throws when the mailer reports failure so the
    // orchestrator's voice-fallback (mirrors the WA sender) kicks in — the
    // call_attempt is only flipped to email/IN_PROGRESS on a real send.
    async sendOffer(attempt, load, owner, priceInr, flow) {
      if (!owner.email) throw new Error("owner has no email on file");
      const subject = `New load [ATT-${attempt.id}] — ${load.fromLocation} → ${load.toLocation} · ${inr(priceInr)}`;
      const text =
        `${route(load)} · ${load.vehicleType} · pickup ${load.pickupDate}\n` +
        `Freight: ${inr(priceInr)}\n\n` +
        `Accept: ${link("acc", attempt.id, priceInr)}\n` +
        `Not available: ${link("dec", attempt.id)}\n` +
        `Counter: reply to this email with your price (e.g. 16500)\n`;
      const ok = await deps.mailer.send(owner.email, subject, text);
      if (!ok) throw new Error("mailer send failed");
      await deps.callsRepo.setConversationId(attempt.id, `em_${attempt.id}`);
      await deps.callsRepo.setStatus(attempt.id, "IN_PROGRESS");
    },

    // Email-channel demands reuse customerPhone to carry the address — same
    // plain-text-column-reuse convention as driver_docs.phone for email docs.
    async sendConfirm(demand, load, ownerName) {
      const to = demand.customerPhone;
      const price = demand.lockedPriceInr ?? load.fixedPriceInr;
      const subject = `Confirm booking [DMD-${demand.id}] — ${route(load)}`;
      const text =
        `${route(load)} · ${load.vehicleType} · ${load.pickupDate}\n` +
        `Agreed price: ${inr(price)}\nDriver: ${ownerName}\n\n` +
        `Confirm: ${link("bok", demand.id)}\n` +
        `Decline: ${link("nbk", demand.id)}\n`;
      await deps.mailer.send(to, subject, text); // best-effort, mirrors WA sendConfirm
    },

    async sendFilled(email, load) {
      await deps.mailer.send(email, `Load filled — ${route(load)}`, `This load (${route(load)}) has been filled. Next time! — ${deps.config.companyName}`);
    },

    async notify(email, subject, text) {
      await deps.mailer.send(email, subject, text);
    },
  };
}
