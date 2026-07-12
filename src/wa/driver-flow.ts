import { Config } from "../config.js";
import { WaInbound } from "./inbound.js";
import { WaSession, WaSessionsRepo } from "./wa-sessions.repo.js";
import { InteraktClient } from "./interakt.client.js";
import { recordAvailability, AvailabilityDeps } from "../quotes/availability.js";
import { CallsRepo, CallAttempt } from "../calls/calls.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { inr } from "./wa-sender.js";
import { parseIntent, parsePriceText } from "./intent.js";
import { Owner } from "../owners/owners.schema.js";
import { DocFlowDeps, handleDriverMedia, handleTypedLr, handleInvoiceConfirm, handleLrReadConfirm, applyTypedInvoiceAmount } from "./doc-flow.js";

export type DriverFlowDeps = {
  availability: AvailabilityDeps;
  interakt: InteraktClient;
  sessions: WaSessionsRepo;
  callsRepo: CallsRepo;
  loadsRepo: LoadsRepo;
  config: Config;
  docs?: DocFlowDeps;
};

const UUID = /^[0-9a-f-]{36}$/i;

export async function handleDriverMessage(
  deps: DriverFlowDeps, m: WaInbound, session: WaSession | null, owner?: Owner | null,
): Promise<void> {
  const say = (t: string) => deps.interakt.sendText(m.from, t);

  // ---- the three actions, shared by button taps and typed answers ----

  async function accept(attemptId: string, price: number | null) {
    // allowUpdate: a driver who countered first can still accept — the stored
    // quote upgrades to accepts_fixed and the (idempotent) lock runs.
    const r = await recordAvailability(deps.availability, {
      cid: `wa_${attemptId}`, available: "YES", acceptsFixed: true, lockPriceInr: price, allowUpdate: true,
    });
    await deps.callsRepo.setStatus(attemptId, "DONE", { ended: true });
    await deps.sessions.clear(m.from);
    if (r.ok && r.locked) {
      return say(`🎉 The load is yours${price ? ` at ${inr(price)}` : ""}. ${deps.config.companyName} will confirm pickup details shortly.`);
    }
    // Not locked by THIS tap — but the lock may already be theirs (dispatcher
    // accepted them on the console, or a double-tap). Never tell the winner
    // someone else got it.
    if (r.ok && r.loadId) {
      const demand = await deps.availability.demandRepo.findByLoadId(r.loadId);
      if (demand?.winningOwnerId && demand.winningOwnerId === r.ownerId) {
        const held = demand.lockedPriceInr;
        return say(`🎉 This load is already yours${held ? ` at ${inr(held)}` : ""}. ${deps.config.companyName} will confirm pickup details shortly.`);
      }
    }
    await say(`Sorry — this load was just filled by another driver. Next time! 🙏`);
  }

  async function counter(attemptId: string, price: number) {
    const r = await recordAvailability(deps.availability, {
      cid: `wa_${attemptId}`, available: "YES", acceptsFixed: false, quotedPriceInr: price, allowUpdate: true,
    });
    await deps.callsRepo.setStatus(attemptId, "DONE", { ended: true });
    await deps.sessions.clear(m.from);
    await say(
      r.ok
        ? `Got it — ${inr(price)} passed to our team. We'll get back to you shortly.`
        : "Sorry — something went wrong recording your price. Our team will call you.",
    );
  }

  async function decline(attemptId: string) {
    await recordAvailability(deps.availability, { cid: `wa_${attemptId}`, available: "NO", allowUpdate: true });
    await deps.callsRepo.setStatus(attemptId, "DONE", { ended: true });
    await deps.sessions.clear(m.from);
    await say(`No problem — we'll keep you posted on the next load. 🙏`);
  }

  // The price this attempt was offered at: the session carries it for re-offers;
  // otherwise the load's fixed freight.
  async function offerPrice(attempt: CallAttempt): Promise<number | null> {
    const fromSession =
      session?.ctx?.attemptId === attempt.id ? Number(session?.ctx?.priceInr) : NaN;
    if (Number.isFinite(fromSession) && fromSession > 0) return fromSession;
    const load = await deps.loadsRepo.getLoad(attempt.loadId);
    return load?.fixedPriceInr ?? null;
  }

  // ---- button taps ----
  if (m.kind === "reply" && m.replyId) {
    // invy:/invn: (invoice trip confirm) — falls through (returns false) for
    // any other button so the acc/ctr/no handling below still runs.
    if (deps.docs && (await handleInvoiceConfirm(deps.docs, m, session))) return;
    // lrok:/lrno: (shaky vision read awaiting the driver's confirmation)
    if (deps.docs && owner && (await handleLrReadConfirm(deps.docs, m, session, owner))) return;

    const [verb, attemptId, priceStr] = m.replyId.split(":");

    // attemptId is user-controlled (a tapped button id) — pg throws on a bad uuid
    // cast, so validate the shape before it ever reaches a query.
    if ((verb === "acc" || verb === "ctr" || verb === "no") && UUID.test(attemptId ?? "")) {
      const attempt = await deps.callsRepo.getById(attemptId);
      if (!attempt || attempt.phone.replace(/\D/g, "") !== m.from) {
        // spoofed/cross-phone id, or the attempt is gone — don't act on someone else's offer
        await say("Sorry, this offer is no longer active.");
        return;
      }
      if (verb === "acc") return accept(attemptId, Number(priceStr) || (await offerPrice(attempt)));
      if (verb === "no") return decline(attemptId);
      // ctr
      await deps.sessions.upsert({ phone: m.from, role: "driver", state: "AWAIT_PRICE", ctx: { attemptId } });
      await say("What's your price for this trip? Reply with the amount (₹).");
      return;
    }
    // ponytail: unrecognized verb or malformed attemptId falls through to the typed-text handling below
  }

  const text = m.kind === "text" ? (m.text ?? "") : (m.replyTitle ?? "");

  // ---- typed answer while a shaky LR read awaits confirmation ----
  if (session?.state === "CONFIRM_LR_READ" && deps.docs && owner) {
    if (await handleLrReadConfirm(deps.docs, m, session, owner)) return;
  }

  // ---- we asked for the invoice amount we couldn't read off the photo ----
  if (session?.state === "AWAIT_INVOICE_AMOUNT" && deps.docs) {
    const docId = String(session.ctx?.docId ?? "");
    const amount = parsePriceText(text);
    if (amount && docId) {
      const reply = await applyTypedInvoiceAmount(deps.docs, docId, amount, m.from);
      await deps.sessions.clear(m.from);
      await say(reply);
      return;
    }
    await say("Please reply with just the amount — e.g. 16500 or 16.5k");
    return;
  }

  // ---- we asked for their counter amount ----
  if (session?.state === "AWAIT_PRICE") {
    const attemptId = String(session.ctx.attemptId ?? "");
    const price = parsePriceText(text);
    if (price && UUID.test(attemptId)) return counter(attemptId, price);
    const intent = parseIntent(text);
    if (intent.kind === "no" && UUID.test(attemptId)) return decline(attemptId); // "rehne do"
    await say("Please reply with just the amount — e.g. 14000 or 14k");
    return;
  }

  // ---- a document photo/pdf: LR or invoice intake ----
  if (m.kind === "media" && deps.docs && owner) {
    return handleDriverMedia(deps.docs, m, owner);
  }

  // ---- typed answer while an offer is live: understand yes / no / a price ----
  const live = await deps.callsRepo.findLiveWaByPhone(m.from);
  if (live) {
    const intent = parseIntent(text);
    if (intent.kind === "yes") return accept(live.id, await offerPrice(live));
    if (intent.kind === "no") return decline(live.id);
    if (intent.kind === "price") return counter(live.id, intent.priceInr);
    // didn't understand — re-show the offer with its buttons instead of a dead greeting
    const load = await deps.loadsRepo.getLoad(live.loadId);
    const price = (await offerPrice(live)) ?? load?.fixedPriceInr ?? 0;
    const buttons = [
      { id: `acc:${live.id}:${price}`, title: `Accept ${inr(price)}`.slice(0, 20) },
      { id: `ctr:${live.id}`, title: "My price" },
      { id: `no:${live.id}`, title: "Not available" },
    ];
    const opts = await deps.interakt.sendButtons(
      m.from,
      `${load ? `🚛 ${load.fromLocation} → ${load.toLocation} · ${load.vehicleType} · pickup ${load.pickupDate}\nFreight: ${inr(price)}\n\n` : ""}Reply with a button below — or just type "haan", "nahi", or your price (e.g. 14000).`,
      buttons,
    );
    await deps.sessions.upsert({ phone: m.from, role: "driver", state: "OFFERED", ctx: { attemptId: live.id, priceInr: price }, lastOptions: opts });
    return;
  }

  // ---- typed LR number, no live offer to catch it first ----
  if (deps.docs && owner && (await handleTypedLr(deps.docs, text, owner, m.from))) return;

  // ---- no live offer: walk the driver through everything they can do here ----
  await say(
    `Namaste 🙏 Main ${deps.config.companyName} ka saathi hoon. We'll message you here when a load matches your route.\n\n` +
      `Aap yahan ye sab kar sakte hain:\n` +
      `📄 *LR / bilty ka status* — LR ki photo bhejein (ya number type karein, jaise PIN-ABC123) → main bataunga payment hua ya nahi\n` +
      `🧾 *Invoice bhejein* — bhade ke bill ki photo bhejein → main amount check karke team ko dunga\n` +
      `🚛 *Naya load* — load milte hi offer yahin aayega, buttons se jawab dein\n\n` +
      `📸 Photo tip: poora page dikhe, roshni achhi ho, seedha angle.`,
  );
}
