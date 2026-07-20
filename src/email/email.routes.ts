import { FastifyInstance } from "fastify";
import { Config } from "../config.js";
import { ActionDeps, acceptAttempt, declineAttempt, bookDemand, declineBooking } from "../calls/actions.js";
import { MintDeps, mintLr } from "../lr/mint.js";
import { inr } from "../wa/wa-sender.js";
import { verifyAction } from "./tokens.js";
import { resultPage } from "./templates.js";

const UUID = /^[0-9a-f-]{36}$/i;

// Public magic-link routes clicked straight from an email — the HMAC token IS
// the auth, so there's no preHandler here. Registered unconditionally: harmless
// dead ends when nothing points at them (i.e. email sending is disabled).
export function registerEmailRoutes(
  app: FastifyInstance,
  deps: { config: Config; actions: ActionDeps; mint?: MintDeps },
) {
  app.get("/e/:action", async (req, reply) => {
    const { action } = req.params as { action: string };
    const { t } = req.query as { t?: string };
    const token = verifyAction(deps.config.webhookSecret, t ?? "");
    reply.type("text/html");
    if (!token || token.a !== action || !UUID.test(token.id)) {
      return reply.code(400).send(resultPage("⏳", "Link expired", "This link is no longer valid — just reply to the email and our team will help.", "warn"));
    }

    if (action === "acc") {
      const outcome = await acceptAttempt(deps.actions, token.id, token.p ?? null);
      if (outcome.kind === "locked") {
        const price = outcome.priceInr != null ? ` at ${inr(outcome.priceInr)}` : "";
        return reply.send(resultPage("✅", "Load accepted!", `The load is yours${price}. We'll confirm pickup details shortly.`));
      }
      if (outcome.kind === "already_yours") {
        const price = outcome.priceInr != null ? ` at ${inr(outcome.priceInr)}` : "";
        return reply.send(resultPage("✅", "Already yours", `This load is already assigned to you${price}.`));
      }
      return reply.send(resultPage("🚚", "Load already filled", "Another driver took this one first — we'll send you the next match.", "warn"));
    }
    if (action === "dec") {
      await declineAttempt(deps.actions, token.id);
      return reply.send(resultPage("👍", "Marked not available", "No problem — we'll keep the next matching loads coming your way."));
    }
    if (action === "bok") {
      const result = await bookDemand(deps.actions, token.id);
      if (result === "not_pending") return reply.send(resultPage("✅", "Already handled", "This booking was already resolved. Nothing more to do."));
      if (deps.mint) {
        const demand = await deps.actions.demandRepo.getById(token.id);
        if (demand?.loadId) await mintLr(deps.mint, demand.loadId); // best-effort
      }
      return reply.send(resultPage("🎉", "Trip booked!", "Your load is confirmed. The driver will be in touch before pickup."));
    }
    if (action === "nbk") {
      const result = await declineBooking(deps.actions, token.id);
      if (result === "not_pending") return reply.send(resultPage("✅", "Already handled", "This booking was already resolved."));
      return reply.send(resultPage("✖️", "Booking declined", "We've cancelled this trip. Reply to the email anytime to arrange another.", "warn"));
    }
  });
}
