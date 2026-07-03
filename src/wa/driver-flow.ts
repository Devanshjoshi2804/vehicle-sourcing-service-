import { Config } from "../config.js";
import { WaInbound } from "./inbound.js";
import { WaSession, WaSessionsRepo } from "./wa-sessions.repo.js";
import { InteraktClient } from "./interakt.client.js";
import { recordAvailability, AvailabilityDeps } from "../quotes/availability.js";
import { CallsRepo } from "../calls/calls.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { inr } from "./wa-sender.js";

export type DriverFlowDeps = {
  availability: AvailabilityDeps;
  interakt: InteraktClient;
  sessions: WaSessionsRepo;
  callsRepo: CallsRepo;
  loadsRepo: LoadsRepo;
  config: Config;
};

const parsePrice = (s: string): number | null => {
  const n = Number((s || "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n >= 100 ? n : null; // <100 is never a freight price
};

export async function handleDriverMessage(deps: DriverFlowDeps, m: WaInbound, session: WaSession | null): Promise<void> {
  const say = (t: string) => deps.interakt.sendText(m.from, t);

  if (m.kind === "reply" && m.replyId) {
    const [verb, attemptId, priceStr] = m.replyId.split(":");
    const cid = `wa_${attemptId}`;

    if (verb === "acc") {
      const price = Number(priceStr) || undefined;
      const r = await recordAvailability(deps.availability, {
        cid, available: "YES", acceptsFixed: true, lockPriceInr: price ?? null,
      });
      await deps.callsRepo.setStatus(attemptId, "DONE", { ended: true });
      await deps.sessions.clear(m.from);
      await say(
        r.ok && r.locked
          ? `🎉 The load is yours at ${inr(price ?? 0)}. ${deps.config.companyName} will confirm pickup details shortly.`
          : `Sorry — this load was just filled by another driver. Next time! 🙏`,
      );
      return;
    }

    if (verb === "ctr") {
      await deps.sessions.upsert({ phone: m.from, role: "driver", state: "AWAIT_PRICE", ctx: { attemptId } });
      await say("What's your price for this trip? Reply with the amount (₹).");
      return;
    }

    if (verb === "no") {
      await recordAvailability(deps.availability, { cid, available: "NO" });
      await deps.callsRepo.setStatus(attemptId, "DONE", { ended: true });
      await deps.sessions.clear(m.from);
      await say(`No problem — we'll keep you posted on the next load. 🙏`);
      return;
    }
  }

  // free text while we're waiting on their counter amount
  if (session?.state === "AWAIT_PRICE" && m.kind === "text") {
    const attemptId = String(session.ctx.attemptId ?? "");
    const price = parsePrice(m.text ?? "");
    if (!price) {
      await say("Please reply with just the amount, e.g. 14000");
      return;
    }
    await recordAvailability(deps.availability, {
      cid: `wa_${attemptId}`, available: "YES", acceptsFixed: false, quotedPriceInr: price,
    });
    await deps.callsRepo.setStatus(attemptId, "DONE", { ended: true });
    await deps.sessions.clear(m.from);
    await say(`Got it — ${inr(price)} passed to our team. We'll get back to you shortly.`);
    return;
  }

  // a driver texting outside any active offer
  await say(`Namaste! We'll message you here when a load matches your route. — ${deps.config.companyName}`);
}
