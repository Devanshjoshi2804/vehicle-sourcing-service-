import { Config } from "../config.js";
import { WaInbound } from "./inbound.js";
import { WaSession, WaSessionsRepo } from "./wa-sessions.repo.js";
import { InteraktClient } from "./interakt.client.js";
import { CaptureDeps, captureDemand } from "../demand/sourcing.js";
import { DemandRepo } from "../demand/demand.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { ParsedLoad } from "./llm-parse.js";
import { inr } from "./wa-sender.js";

export type CustomerFlowDeps = {
  capture: CaptureDeps;
  interakt: InteraktClient;
  sessions: WaSessionsRepo;
  demandRepo: DemandRepo;
  loadsRepo: LoadsRepo;
  parseLoad: (text: string, today: string) => Promise<ParsedLoad>;
  config: Config;
};

type Draft = { fromText?: string; toText?: string; vehicleType?: string; priceInr?: number; pickupDate?: string };
const VEHICLES = ["Tata Ace", "14ft", "16ft", "17ft", "19ft", "22ft", "Container"];
const todayIso = (d = new Date()) => d.toISOString().slice(0, 10);
const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return todayIso(d); };

// The next field the draft is missing, in ask-order. null = ready to confirm.
function nextField(d: Draft): "fromText" | "toText" | "vehicleType" | "pickupDate" | "priceInr" | null {
  if (!d.fromText) return "fromText";
  if (!d.toText) return "toText";
  if (!d.vehicleType) return "vehicleType";
  if (!d.pickupDate) return "pickupDate";
  if (!d.priceInr) return "priceInr";
  return null;
}

async function prompt(deps: CustomerFlowDeps, phone: string, draft: Draft): Promise<void> {
  const field = nextField(draft);
  if (field === null) {
    const body =
      `📋 Load summary\n${draft.fromText} → ${draft.toText} · ${draft.vehicleType}\n` +
      `Pickup ${draft.pickupDate} · ${inr(draft.priceInr!)}\n\nPost this load?`;
    const opts = await deps.interakt.sendButtons(phone, body, [
      { id: "cfm:yes", title: "✅ Confirm" }, { id: "cfm:edit", title: "✏️ Edit" }, { id: "cfm:no", title: "❌ Cancel" },
    ]);
    await deps.sessions.upsert({ phone, role: "customer", state: "CONFIRM", ctx: { draft }, lastOptions: opts });
    return;
  }
  const state = { fromText: "ASK_FROM", toText: "ASK_TO", vehicleType: "ASK_VEHICLE", pickupDate: "ASK_DATE", priceInr: "ASK_PRICE" }[field];
  let opts: { id: string; title: string }[] = [];
  if (field === "vehicleType") {
    opts = await deps.interakt.sendList(phone, "Which vehicle do you need?", "Choose vehicle",
      VEHICLES.map((v) => ({ id: `veh:${v}`, title: v })));
  } else if (field === "pickupDate") {
    opts = await deps.interakt.sendButtons(phone, "When is the pickup?", [
      { id: "date:today", title: "Today" }, { id: "date:tomorrow", title: "Tomorrow" }, { id: "date:type", title: "Type a date" },
    ]);
  } else {
    const q = { fromText: "Pickup city?", toText: "Drop city?", priceInr: "Your price for this trip? (₹)" }[field];
    await deps.interakt.sendText(phone, q!);
  }
  await deps.sessions.upsert({ phone, role: "customer", state, ctx: { draft }, lastOptions: opts });
}

export async function handleCustomerMessage(deps: CustomerFlowDeps, m: WaInbound, session: WaSession | null): Promise<void> {
  const say = (t: string) => deps.interakt.sendText(m.from, t);
  const draft: Draft = { ...((session?.ctx?.draft as Draft) ?? {}) };
  const state = session?.state ?? "IDLE";

  // ---- booking confirm (domino step 4) ----
  if (state === "CONFIRM_BOOKING" && m.kind === "reply" && m.replyId) {
    const [verb, demandId] = m.replyId.split(":");
    const d = await deps.demandRepo.getById(demandId);
    if (d && verb === "bok") {
      const booked = await deps.demandRepo.book(d.id);
      if (booked && d.loadId) await deps.loadsRepo.setStatus(d.loadId, "BOOKED");
      await deps.sessions.clear(m.from);
      await say(booked ? "🎉 Booked! The driver will call you before pickup." : "This booking is no longer pending.");
      return;
    }
    if (d && verb === "dec") {
      await deps.demandRepo.setStatus(d.id, "DECLINED");
      if (d.loadId) await deps.loadsRepo.setStatus(d.loadId, "CLOSED");
      await deps.sessions.clear(m.from);
      await say("No problem — the booking is cancelled. Message us anytime for a new load.");
      return;
    }
  }

  // ---- confirm-summary buttons ----
  if (state === "CONFIRM" && m.kind === "reply") {
    if (m.replyId === "cfm:yes") {
      const r = await captureDemand(deps.capture, {
        customerPhone: `+${m.from}`, fromText: draft.fromText!, toText: draft.toText!,
        vehicleType: draft.vehicleType, offeredPriceInr: draft.priceInr, pickupDate: draft.pickupDate,
        conversationId: `wa_${m.msgId}`, channel: "whatsapp",
      });
      await deps.sessions.clear(m.from);
      await say(r.sourcing.sourced
        ? "🔎 Finding you a truck — I'll message you here as soon as a driver is confirmed."
        : "✅ Load received! Our team will arrange a truck and message you here.");
      return;
    }
    if (m.replyId === "cfm:edit") {
      // start over, keeping nothing typed wrong: clear draft, re-ask from the top
      await deps.sessions.upsert({ phone: m.from, role: "customer", state: "ASK_FROM", ctx: { draft: {} }, lastOptions: [] });
      await say("Okay, let's redo it. Pickup city?");
      return;
    }
    if (m.replyId === "cfm:no") {
      await deps.sessions.clear(m.from);
      await say("Cancelled. Message me the route + vehicle + price anytime to post a load.");
      return;
    }
  }

  // ---- field answers ----
  if (state === "ASK_VEHICLE" && m.kind === "reply" && m.replyId?.startsWith("veh:")) {
    draft.vehicleType = m.replyId.slice(4);
    return prompt(deps, m.from, draft);
  }
  if (state === "ASK_DATE") {
    if (m.kind === "reply" && m.replyId === "date:today") { draft.pickupDate = todayIso(); return prompt(deps, m.from, draft); }
    if (m.kind === "reply" && m.replyId === "date:tomorrow") { draft.pickupDate = plusDays(1); return prompt(deps, m.from, draft); }
    if (m.kind === "reply" && m.replyId === "date:type") { await say("Please type the date as YYYY-MM-DD (e.g. 2026-07-05)."); return; }
    if (m.kind === "text" && /^\d{4}-\d{2}-\d{2}$/.test(m.text ?? "")) { draft.pickupDate = m.text!; return prompt(deps, m.from, draft); }
    await say("Please pick a date, or type it as YYYY-MM-DD.");
    return;
  }
  if (state === "ASK_PRICE" && m.kind === "text") {
    const n = Number((m.text ?? "").replace(/[^\d]/g, ""));
    if (Number.isFinite(n) && n >= 100) { draft.priceInr = n; return prompt(deps, m.from, draft); }
    await say("Please reply with just the amount, e.g. 13000");
    return;
  }
  if (state === "ASK_FROM" && m.kind === "text" && m.text) { draft.fromText = m.text; return prompt(deps, m.from, draft); }
  if (state === "ASK_TO" && m.kind === "text" && m.text) { draft.toText = m.text; return prompt(deps, m.from, draft); }

  // ---- unrecognized reply mid-flow: re-prompt with the draft as-is, don't lose it ----
  if (state === "ASK_VEHICLE" && m.kind === "text") {
    await say("Please pick a vehicle from the list 👇");
    return prompt(deps, m.from, draft);
  }
  if (state === "CONFIRM") {
    await say("Please tap one of the buttons above 👆");
    return prompt(deps, m.from, draft);
  }

  // ---- fresh message: try the one-shot parse ----
  if (m.kind === "text" && m.text) {
    const p = await deps.parseLoad(m.text, todayIso());
    const parsedDraft: Draft = {
      fromText: p.fromText ?? undefined, toText: p.toText ?? undefined, vehicleType: p.vehicleType ?? undefined,
      priceInr: p.priceInr ?? undefined, pickupDate: p.pickupDate ?? undefined,
    };
    if (nextField(parsedDraft) === "fromText" && !p.toText) {
      // nothing usable parsed — greet + start guided
      await say(`Namaste ${m.contactName}! 🚛 Tell me your load — e.g. "16ft Mumbai to Pune ₹13000 tomorrow" — or answer step by step.`);
    }
    return prompt(deps, m.from, parsedDraft);
  }

  await say(`Namaste! Send me your load — route, vehicle and price — and I'll find you a truck. — ${deps.config.companyName}`);
}
