import { Config } from "../config.js";
import { EmailMsg } from "./inbound.js";
import { EmailSession, EmailSessionsRepo } from "./email-sessions.repo.js";
import { CaptureDeps, captureDemand } from "../demand/sourcing.js";
import { DemandRepo } from "../demand/demand.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { ParsedLoad } from "../wa/llm-parse.js";
import { inr } from "../wa/wa-sender.js";
import { parseIntent } from "../wa/intent.js";
import { Mailer } from "./mailer.js";
import { noticeEmail } from "./templates.js";

export type CustomerFlowDeps = {
  capture: CaptureDeps;
  mailer: Mailer;
  sessions: EmailSessionsRepo;
  demandRepo: DemandRepo;
  loadsRepo: LoadsRepo;
  parseLoad: (text: string, today: string) => Promise<ParsedLoad>;
  config: Config;
};

type Draft = { fromText?: string; toText?: string; vehicleType?: string; priceInr?: number; pickupDate?: string };
const todayIso = (d = new Date()) => d.toISOString().slice(0, 10);

function replySubject(subject: string): string {
  const s = (subject || "").trim();
  return /^re:/i.test(s) ? s : `Re: ${s || "your load"}`;
}

// Unlike WA (one field at a time via buttons), email has no interactive
// widgets — ask for everything still missing in a single reply-friendly list.
function missingFields(d: Draft): string[] {
  const out: string[] = [];
  if (!d.fromText) out.push("Pickup city (e.g. Mumbai)");
  if (!d.toText) out.push("Drop city (e.g. Pune)");
  if (!d.vehicleType) out.push("Vehicle type (e.g. 16ft, Tata Ace, Container)");
  if (!d.pickupDate) out.push("Pickup date (YYYY-MM-DD, or \"today\"/\"tomorrow\")");
  if (!d.priceInr) out.push("Your price for this trip (₹)");
  return out;
}

function mergeParsed(draft: Draft, p: ParsedLoad): void {
  if (p.fromText) draft.fromText = p.fromText;
  if (p.toText) draft.toText = p.toText;
  if (p.vehicleType) draft.vehicleType = p.vehicleType;
  if (p.priceInr) draft.priceInr = p.priceInr;
  if (p.pickupDate) draft.pickupDate = p.pickupDate;
}

const asksFor = (missing: string[]) =>
  `Reply with the missing details:\n${missing.map((f) => `- ${f}`).join("\n")}`;

const summaryFor = (d: Draft) =>
  `Load summary\n${d.fromText} → ${d.toText} · ${d.vehicleType}\nPickup ${d.pickupDate} · ${inr(d.priceInr!)}\n\n` +
  `Reply YES to post this load, or NO to cancel.`;

export async function handleCustomerMessage(deps: CustomerFlowDeps, m: EmailMsg, session: EmailSession | null): Promise<void> {
  const reply = (text: string) => {
    const subject = replySubject(m.subject);
    const built = noticeEmail(subject, "", text); // branded HTML wrapper, plaintext fallback preserved
    return deps.mailer.send(m.from, subject, text, built.html);
  };
  const draft: Draft = { ...((session?.ctx?.draft as Draft) ?? {}) };
  const state = session?.state ?? "IDLE";

  // ---- customers dump full sentences; documents are a driver-only feature ----
  if (m.attachments.length) {
    await reply("Documents are for drivers — reply with your route, vehicle and price instead.");
    return;
  }

  const text = m.text ?? "";

  // ---- confirm-summary reply: YES posts the load, NO cancels ----
  if (state === "CONFIRM") {
    const intent = parseIntent(text);
    if (intent.kind === "yes") {
      const r = await captureDemand(deps.capture, {
        customerPhone: m.from, fromText: draft.fromText!, toText: draft.toText!,
        vehicleType: draft.vehicleType, offeredPriceInr: draft.priceInr, pickupDate: draft.pickupDate,
        conversationId: `em_${m.messageId}`, channel: "email",
      });
      await deps.sessions.clear(m.from);
      await reply(
        r.sourcing.sourced
          ? "Finding you a truck — we'll email you here as soon as a driver is confirmed."
          : "Load received! Our team will arrange a truck and email you here.",
      );
      return;
    }
    if (intent.kind === "no") {
      await deps.sessions.clear(m.from);
      await reply("Cancelled. Reply anytime with your route, vehicle and price to post a new load.");
      return;
    }
    await reply("Please reply YES to confirm or NO to cancel.");
    return;
  }

  // ---- collecting: parse-merge every reply until the draft is complete ----
  if (state === "COLLECTING") {
    mergeParsed(draft, await deps.parseLoad(text, todayIso()));
    const missing = missingFields(draft);
    if (missing.length) {
      await deps.sessions.upsert({ address: m.from, role: "customer", state: "COLLECTING", ctx: { draft } });
      await reply(asksFor(missing));
      return;
    }
    await deps.sessions.upsert({ address: m.from, role: "customer", state: "CONFIRM", ctx: { draft } });
    await reply(summaryFor(draft));
    return;
  }

  // ---- fresh message: one-shot parse ----
  const p = await deps.parseLoad(text, todayIso());
  // Cold-contact guard: this is a public inbox, so random senders (newsletters,
  // notifications, cold outreach) land here. Only engage a first-time stranger
  // when the email actually reads like a load (>= 2 recognizable fields).
  // Anything less is silently ignored — no reply, no session — so we never
  // auto-email non-customers. Once a customer is mid-flow the branches above
  // keep replying regardless.
  const parsedFields = [p.fromText, p.toText, p.vehicleType, p.priceInr, p.pickupDate].filter((x) => x != null).length;
  if (parsedFields < 2) return;
  mergeParsed(draft, p);
  const missing = missingFields(draft);
  if (!missing.length) {
    await deps.sessions.upsert({ address: m.from, role: "customer", state: "CONFIRM", ctx: { draft } });
    await reply(summaryFor(draft));
    return;
  }

  await deps.sessions.upsert({ address: m.from, role: "customer", state: "COLLECTING", ctx: { draft } });
  const noneParsed = missing.length === 5;
  await reply(
    (noneParsed
      ? `Hi! Tell us your load — route, vehicle and price — and we'll find you a truck. ` +
        `For example: "16ft Mumbai to Pune ₹13000 tomorrow".\n\n`
      : "") + asksFor(missing),
  );
}
