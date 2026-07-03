import { Config } from "../config.js";
import { InteraktClient } from "./interakt.client.js";
import { WaSessionsRepo } from "./wa-sessions.repo.js";
import { CallsRepo, CallAttempt, CallFlow } from "../calls/calls.repo.js";
import { Load } from "../loads/loads.schema.js";
import { Owner } from "../owners/owners.schema.js";
import { DemandRequest } from "../demand/demand.repo.js";

export const digits = (phone: string) => phone.replace(/\D/g, "");
export const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export type WaSender = {
  sendOffer(attempt: CallAttempt, load: Load, owner: Owner, priceInr: number, flow: CallFlow): Promise<void>;
  sendFilled(phone: string, load: Load): Promise<void>;
  sendConfirm(demand: DemandRequest, load: Load, ownerName: string): Promise<void>;
  sendText(phone: string, text: string): Promise<void>;
};

export function buildWaSender(deps: {
  interakt: InteraktClient;
  callsRepo: CallsRepo;
  sessions: WaSessionsRepo;
  config: Config;
}): WaSender {
  const route = (load: Load) => `${load.fromLocation} → ${load.toLocation}`;

  return {
    // Template send (business-initiated). Conversation id wa_<attemptId> ties the
    // driver's reply back to this attempt through the normal quotes path.
    async sendOffer(attempt, load, owner, priceInr, flow) {
      const to = digits(owner.phone);
      // Always all 3 buttons: the approved template has fixed button slots, so a
      // 2-button send would map slot 1 ("My price") onto the no: payload. A counter
      // on a follow-up/re-offer is a legitimate outcome anyway.
      const buttons = [
        { id: `acc:${attempt.id}:${priceInr}`, title: `Accept ${inr(priceInr)}`.slice(0, 20) },
        { id: `ctr:${attempt.id}`, title: "My price" },
        { id: `no:${attempt.id}`, title: "Not available" },
      ];
      await deps.interakt.sendTemplate(
        to,
        "sourcing_offer",
        [route(load), load.vehicleType, load.pickupDate, String(priceInr)],
        Object.fromEntries(buttons.map((b, i) => [String(i), [b.id]])),
      );
      await deps.callsRepo.setConversationId(attempt.id, `wa_${attempt.id}`);
      await deps.callsRepo.setStatus(attempt.id, "IN_PROGRESS");
      // template button clicks can come back title-only — remember the mapping
      await deps.sessions.upsert({ phone: to, role: "driver", state: "OFFERED", ctx: { attemptId: attempt.id, priceInr }, lastOptions: buttons });
    },

    async sendFilled(phone, load) {
      try {
        await deps.interakt.sendText(digits(phone), `This load (${route(load)}) has been filled. Next time! 🙏 — ${deps.config.companyName}`);
      } catch { /* best-effort */ }
    },

    // Session buttons first (customer messaged us recently in every normal domino
    // run); approved template as the out-of-window fallback.
    async sendConfirm(demand, load, ownerName) {
      const to = digits(demand.customerPhone);
      const price = demand.lockedPriceInr ?? load.fixedPriceInr;
      const buttons = [
        { id: `bok:${demand.id}`, title: "Confirm booking" },
        { id: `dec:${demand.id}`, title: "Decline" },
      ];
      const body =
        `🚛 Driver found!\n${route(load)} · ${load.vehicleType} · ${load.pickupDate}\n` +
        `Agreed price: ${inr(price)}\nDriver: ${ownerName}\n\nBook this trip?`;
      try {
        const opts = await deps.interakt.sendButtons(to, body, buttons);
        await deps.sessions.upsert({ phone: to, role: "customer", state: "CONFIRM_BOOKING", ctx: { demandId: demand.id }, lastOptions: opts });
      } catch {
        // session send failed (likely outside the 24h window) — try the approved
        // template. sendConfirm must never throw: on total failure the demand just
        // stays CUSTOMER_PENDING and the dispatcher's next retry re-sends it.
        try {
          await deps.interakt.sendTemplate(to, "sourcing_confirm",
            [route(load), String(price), ownerName],
            { "0": [buttons[0].id], "1": [buttons[1].id] });
          await deps.sessions.upsert({ phone: to, role: "customer", state: "CONFIRM_BOOKING", ctx: { demandId: demand.id }, lastOptions: buttons });
        } catch { /* both sends failed — best-effort, skip session upsert */ }
      }
    },

    async sendText(phone, text) {
      try {
        await deps.interakt.sendText(digits(phone), text);
      } catch { /* best-effort */ }
    },
  };
}
