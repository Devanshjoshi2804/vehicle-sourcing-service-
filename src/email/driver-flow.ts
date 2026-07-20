import { Config } from "../config.js";
import { EmailMsg } from "./inbound.js";
import { EmailSession, EmailSessionsRepo } from "./email-sessions.repo.js";
import { AvailabilityDeps } from "../quotes/availability.js";
import { CallsRepo, CallAttempt } from "../calls/calls.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { ActionDeps, acceptAttempt, counterAttempt, declineAttempt } from "../calls/actions.js";
import { inr } from "../wa/wa-sender.js";
import { parseIntent, parsePriceText } from "../wa/intent.js";
import { Owner } from "../owners/owners.schema.js";
import { Mailer } from "./mailer.js";
import { noticeEmail } from "./templates.js";
import { InteraktClient } from "../wa/interakt.client.js";
import {
  DocFlowDeps,
  handleDriverDocBuffer,
  handleTypedLr,
  confirmInvoiceTrip,
  applyTypedInvoiceAmount,
  NO_TRIP,
  NO_TOTAL,
} from "../wa/doc-flow.js";

// Everything doc-flow's email-facing helpers (handleDriverDocBuffer, handleTypedLr,
// confirmInvoiceTrip, applyTypedInvoiceAmount) actually touch — NOT interakt/sessions,
// which are WA-only fields on DocFlowDeps that those four functions never read.
export type EmailDocsDeps = Pick<DocFlowDeps, "vision" | "lrsRepo" | "docsRepo" | "loadsRepo" | "demandRepo" | "config">;

export type DriverFlowDeps = {
  availability: AvailabilityDeps;
  callsRepo: CallsRepo;
  loadsRepo: LoadsRepo;
  config: Config;
  mailer: Mailer;
  sessions: EmailSessionsRepo;
  docs?: EmailDocsDeps;
};

const UUID = /^[0-9a-f-]{36}$/i;

function replySubject(subject: string): string {
  const s = (subject || "").trim();
  return /^re:/i.test(s) ? s : `Re: ${s || "your message"}`;
}

// doc-flow's shared helpers are typed against DocFlowDeps (WA-shaped: an
// InteraktClient + a WaSessionsRepo). Only .sendText is ever called by the
// functions the email flow uses — wire it straight to the per-message replyFn
// and make the rest loudly fail if some future change starts calling them.
function docFlowDeps(base: EmailDocsDeps, replyFn: (text: string) => Promise<void>): DocFlowDeps {
  const interakt: InteraktClient = {
    async sendText(_to, text) {
      await replyFn(text);
    },
    async sendButtons(): Promise<never> {
      throw new Error("email channel has no interactive buttons");
    },
    async sendList(): Promise<never> {
      throw new Error("email channel has no interactive lists");
    },
    async sendTemplate() {
      throw new Error("email channel has no templates");
    },
  };
  return {
    ...base,
    interakt,
    // ponytail: never read by handleDriverDocBuffer/handleTypedLr/confirmInvoiceTrip/
    // applyTypedInvoiceAmount — upgrade to a real store if a future helper needs it.
    sessions: undefined as unknown as DocFlowDeps["sessions"],
  };
}

export async function handleDriverMessage(
  deps: DriverFlowDeps, m: EmailMsg, session: EmailSession | null, owner: Owner,
): Promise<void> {
  const reply = async (text: string) => {
    const subject = replySubject(m.subject);
    const built = noticeEmail(subject, "", text); // branded HTML wrapper, plaintext fallback preserved
    await deps.mailer.send(owner.email ?? m.from, subject, text, built.html);
  };
  const actionDeps: ActionDeps = {
    availability: deps.availability, callsRepo: deps.callsRepo, loadsRepo: deps.loadsRepo,
    demandRepo: deps.availability.demandRepo,
  };

  async function accept(attemptId: string, price: number | null) {
    const outcome = await acceptAttempt(actionDeps, attemptId, price);
    await deps.sessions.clear(m.from);
    if (outcome.kind === "locked") {
      return reply(`The load is yours${outcome.priceInr ? ` at ${inr(outcome.priceInr)}` : ""}. ${deps.config.companyName} will confirm pickup details shortly.`);
    }
    if (outcome.kind === "already_yours") {
      return reply(`This load is already yours${outcome.priceInr ? ` at ${inr(outcome.priceInr)}` : ""}. ${deps.config.companyName} will confirm pickup details shortly.`);
    }
    await reply("Sorry — this load was just filled by another driver. Next time!");
  }

  async function counter(attemptId: string, price: number) {
    const r = await counterAttempt(actionDeps, attemptId, price);
    await deps.sessions.clear(m.from);
    await reply(
      r.ok
        ? `Got it — ${inr(price)} passed to our team. We'll get back to you shortly.`
        : "Sorry — something went wrong recording your price. Our team will call you.",
    );
  }

  async function decline(attemptId: string) {
    await declineAttempt(actionDeps, attemptId);
    await deps.sessions.clear(m.from);
    await reply("No problem — we'll keep you posted on the next load.");
  }

  async function offerPrice(attempt: CallAttempt): Promise<number | null> {
    const fromSession = session?.ctx?.attemptId === attempt.id ? Number(session?.ctx?.priceInr) : NaN;
    if (Number.isFinite(fromSession) && fromSession > 0) return fromSession;
    const load = await deps.loadsRepo.getLoad(attempt.loadId);
    return load?.fixedPriceInr ?? null;
  }

  // Attempt resolution for a reply with no button to carry an id: the subject
  // tag (ATT-<uuid>, only when it's THIS owner's attempt) first, else the
  // owner's newest live email offer.
  async function resolveAttempt(): Promise<CallAttempt | null> {
    if (m.tags.attempt && UUID.test(m.tags.attempt)) {
      const a = await deps.callsRepo.getById(m.tags.attempt);
      if (a && a.ownerId === owner.id) return a;
    }
    return deps.callsRepo.findLiveByOwner(owner.id, "email");
  }

  const text = m.text ?? "";

  // ---- CONFIRM_INVOICE_TRIP: reply YES/NO to the guessed trip ----
  if (session?.state === "CONFIRM_INVOICE_TRIP" && deps.docs) {
    const docId = String(session.ctx?.docId ?? "");
    const loadId = String(session.ctx?.loadId ?? "");
    const intent = parseIntent(text);
    if (intent.kind === "no") {
      await deps.sessions.clear(m.from);
      await reply(NO_TRIP);
      return;
    }
    if (intent.kind === "yes") {
      const cmp = await confirmInvoiceTrip(docFlowDeps(deps.docs, reply), docId, loadId);
      if (!cmp) {
        await deps.sessions.clear(m.from);
        await reply(NO_TRIP);
        return;
      }
      if (cmp.reply === NO_TOTAL) {
        await deps.sessions.upsert({ address: m.from, role: "driver", state: "AWAIT_INVOICE_AMOUNT", ctx: { docId, loadId } });
      } else {
        await deps.sessions.clear(m.from);
      }
      await reply(cmp.reply);
      return;
    }
    await reply("Please reply YES or NO.");
    return;
  }

  // ---- we asked for the invoice amount we couldn't read off the photo ----
  if (session?.state === "AWAIT_INVOICE_AMOUNT" && deps.docs) {
    const docId = String(session.ctx?.docId ?? "");
    const amount = parsePriceText(text);
    if (amount && docId) {
      const replyText = await applyTypedInvoiceAmount(docFlowDeps(deps.docs, reply), docId, amount, owner.phone);
      await deps.sessions.clear(m.from);
      await reply(replyText);
      return;
    }
    await reply("Please reply with just the amount — e.g. 16500 or 16.5k");
    return;
  }

  // ---- we asked for their counter amount ----
  if (session?.state === "AWAIT_PRICE") {
    const attemptId = String(session.ctx?.attemptId ?? "");
    const price = parsePriceText(text);
    if (price && UUID.test(attemptId)) return counter(attemptId, price);
    const intent = parseIntent(text);
    if (intent.kind === "no" && UUID.test(attemptId)) return decline(attemptId); // "not available"
    await reply("Please reply with just the amount — e.g. 14000 or 14k");
    return;
  }

  // ---- attachments: LR / invoice photos (≤5, normalizeEmail already caps it) ----
  if (m.attachments.length && deps.docs) {
    for (const att of m.attachments) {
      const filename = att.filename || "attachment";
      const sourceRef = m.messageId ? `email:${m.messageId}/${filename}` : `email:unknown/${filename}`;
      const pending = await handleDriverDocBuffer(docFlowDeps(deps.docs, reply), owner, reply, att.buffer, att.mime, sourceRef);
      if (pending?.kind === "confirm_invoice_trip" || pending?.kind === "await_invoice_amount") {
        await deps.sessions.upsert({ address: m.from, role: "driver", state: pending.kind.toUpperCase(), ctx: { docId: pending.docId, loadId: pending.loadId } });
      }
    }
    return;
  }

  // ---- typed answer while an offer is live: understand yes / no / a price ----
  const live = await resolveAttempt();
  if (live) {
    const intent = parseIntent(text);
    if (intent.kind === "yes") return accept(live.id, await offerPrice(live));
    if (intent.kind === "no") return decline(live.id);
    if (intent.kind === "price") return counter(live.id, intent.priceInr);
    // didn't understand — re-show the offer instead of a dead greeting
    const load = await deps.loadsRepo.getLoad(live.loadId);
    const price = (await offerPrice(live)) ?? load?.fixedPriceInr ?? 0;
    await reply(
      `${load ? `${load.fromLocation} → ${load.toLocation} · ${load.vehicleType} · pickup ${load.pickupDate}\nFreight: ${inr(price)}\n\n` : ""}` +
        `Reply YES to accept, NO if not available, or type your price (e.g. 14000).`,
    );
    await deps.sessions.upsert({ address: m.from, role: "driver", state: "OFFERED", ctx: { attemptId: live.id, priceInr: price } });
    return;
  }

  // ---- typed LR number, no live offer to catch it first ----
  if (deps.docs && (await handleTypedLr(docFlowDeps(deps.docs, reply), text, owner, owner.phone))) return;

  // ---- no live offer: walk the driver through everything they can do here ----
  await reply(
    `Hi — I'm ${deps.config.companyName}'s booking assistant. We'll email you here when a load matches your route.\n\n` +
      `Reply to this email to:\n` +
      `- Check an LR / bilty status — attach a photo, or type the LR number (e.g. PIN-ABC123)\n` +
      `- Send an invoice — attach the freight bill and we'll check the amount against the agreed price\n` +
      `- Answer a load offer — reply YES, NO, or your price whenever one comes in\n`,
  );
}
