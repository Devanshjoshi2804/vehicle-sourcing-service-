import { FastifyInstance } from "fastify";
import { Config } from "../config.js";
import { ActionDeps, acceptAttempt, declineAttempt, bookDemand, declineBooking } from "../calls/actions.js";
import { MintDeps, mintLr } from "../lr/mint.js";
import { inr } from "../wa/wa-sender.js";
import { verifyAction } from "./tokens.js";

const UUID = /^[0-9a-f-]{36}$/i;

const page = (body: string) =>
  `<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:2rem"><h2>${body}</h2></body></html>`;

const EXPIRED = "Link expired — reply to the email instead.";

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
      return reply.code(400).send(page(EXPIRED));
    }

    if (action === "acc") {
      const outcome = await acceptAttempt(deps.actions, token.id, token.p ?? null);
      if (outcome.kind === "locked") {
        const price = outcome.priceInr != null ? ` — ${inr(outcome.priceInr)}` : "";
        return reply.send(page(`✅ Load accepted${price}`));
      }
      if (outcome.kind === "already_yours") return reply.send(page("✅ Already yours"));
      return reply.send(page("❌ Load already filled"));
    }
    if (action === "dec") {
      await declineAttempt(deps.actions, token.id);
      return reply.send(page("👍 Marked not available"));
    }
    if (action === "bok") {
      const result = await bookDemand(deps.actions, token.id);
      if (result === "not_pending") return reply.send(page("Already handled"));
      if (deps.mint) {
        const demand = await deps.actions.demandRepo.getById(token.id);
        if (demand?.loadId) await mintLr(deps.mint, demand.loadId); // best-effort
      }
      return reply.send(page("🎉 Trip booked!"));
    }
    // nbk
    await declineBooking(deps.actions, token.id);
    return reply.send(page("Booking declined"));
  });
}
