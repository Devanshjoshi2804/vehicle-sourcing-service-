import { Config } from "../config.js";
import { Mailer } from "./mailer.js";
import { CallsRepo, CallAttempt, CallFlow } from "../calls/calls.repo.js";
import { Load } from "../loads/loads.schema.js";
import { Owner } from "../owners/owners.schema.js";
import { DemandRequest } from "../demand/demand.repo.js";
import { signAction, ActionToken } from "./tokens.js";
import { inr } from "../wa/wa-sender.js";
import { offerEmail, confirmEmail, noticeEmail } from "./templates.js";

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
      const m = offerEmail({
        from: load.fromLocation, to: load.toLocation, vehicle: load.vehicleType, date: load.pickupDate,
        priceInr: inr(priceInr), attemptTag: `ATT-${attempt.id}`,
        accHref: link("acc", attempt.id, priceInr), decHref: link("dec", attempt.id),
      });
      const ok = await deps.mailer.send(owner.email, m.subject, m.text, m.html);
      if (!ok) throw new Error("mailer send failed");
      await deps.callsRepo.setConversationId(attempt.id, `em_${attempt.id}`);
      await deps.callsRepo.setStatus(attempt.id, "IN_PROGRESS");
    },

    // Email-channel demands reuse customerPhone to carry the address — same
    // plain-text-column-reuse convention as driver_docs.phone for email docs.
    async sendConfirm(demand, load, ownerName) {
      const to = demand.customerPhone;
      const price = demand.lockedPriceInr ?? load.fixedPriceInr;
      const m = confirmEmail({
        from: load.fromLocation, to: load.toLocation, vehicle: load.vehicleType, date: load.pickupDate,
        priceInr: inr(price), driver: ownerName, demandTag: `DMD-${demand.id}`,
        bokHref: link("bok", demand.id), nbkHref: link("nbk", demand.id),
      });
      await deps.mailer.send(to, m.subject, m.text, m.html); // best-effort, mirrors WA sendConfirm
    },

    async sendFilled(email, load) {
      const m = noticeEmail(
        `Load filled — ${route(load)}`,
        "Load filled",
        `This load (${route(load)}) has been filled. We'll send the next matching load your way. Thanks! — ${deps.config.companyName}`,
      );
      await deps.mailer.send(email, m.subject, m.text, m.html);
    },

    async notify(email, subject, text) {
      const m = noticeEmail(subject, subject, text);
      await deps.mailer.send(email, subject, m.text, m.html);
    },
  };
}
