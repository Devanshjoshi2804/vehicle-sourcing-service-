import { Config } from "../config.js";
import { VisionClient, VisionDoc } from "./vision.js";
import { LrsRepo, Lr } from "../lr/lrs.repo.js";
import { DocsRepo, DriverDoc } from "../lr/docs.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { Load } from "../loads/loads.schema.js";
import { DemandRepo } from "../demand/demand.repo.js";
import { InteraktClient } from "./interakt.client.js";
import { WaSessionsRepo, WaSession } from "./wa-sessions.repo.js";
import { WaInbound } from "./inbound.js";
import { Owner } from "../owners/owners.schema.js";
import { inr } from "./wa-sender.js";
import { parseIntent } from "./intent.js";

export type DocFlowDeps = {
  vision: VisionClient;
  lrsRepo: LrsRepo;
  docsRepo: DocsRepo;
  loadsRepo: LoadsRepo;
  demandRepo: DemandRepo;
  interakt: InteraktClient;
  sessions: WaSessionsRepo;
  config: Config;
};

// ---- copy strings — VERBATIM per spec, don't reword ----
// First line stays VERBATIM per spec; the lines below it walk a real driver
// through what happened and what to do, in simple Hindi.
const PHOTO_TIPS =
  "Dobara koshish karein:\n1️⃣ Poora document frame mein ho\n2️⃣ Roshni achhi ho, photo dhundhli na ho\n3️⃣ Seedha upar se photo lein";
const UNREADABLE = `Couldn't read this — please type the LR number, or our team will check.

😕 Photo saaf nahi padh paya. ${PHOTO_TIPS}

Ya seedha *LR number type kar dein* (jaise PIN-ABC123) — main turant status bata dunga 👍`;
const NON_FREIGHT = `This doesn't look like an LR or invoice. Send a photo of the document, or type your LR number.

🤔 Ye LR ya invoice nahi lag raha.
📄 *LR / bilty* = loading ke waqt milne wali parchi (usme LR number likha hota hai)
🧾 *Invoice / bill* = bhade ka bill jisme total amount likha ho

Inme se kisi ki photo bhejein — ya LR number type karein (jaise PIN-ABC123).`;
const TOO_LARGE = `This file is too big — please send a clearer photo under 8 MB.

📸 File badi hai — WhatsApp se normal photo bhejein (document nahi), wo chal jayegi.`;
const WRONG_DRIVER = `This LR belongs to a different vehicle — our team will check.

⚠️ Ye LR kisi aur gaadi ke naam par hai. Hamari team check karke aapse baat karegi 🙏`;
const FUZZY_NOT_FOUND = `Couldn't match this LR — please type the LR number.

🔎 Ye number system mein nahi mila. LR par likha number *type kar dein* (jaise PIN-ABC123) — shayad photo mein galat padha gaya ho.`;
const foreignCreated = (n: string) => `New LR ${n} registered — our team will verify.

✅ Humne LR ${n} register kar liya hai. Team verify karke aapko yahin update degi.`;
const overCap = (n: string) => `Got it — LR ${n} noted, our team will check and get back to you.

📝 Note kar liya hai — team jald aapse sampark karegi 🙏`;
const typedForeignNotFound = (n: string) => `LR ${n} not found — our team will check.

🔎 Ye number system mein nahi mila. Agar LR ki photo hai to bhej dein — team bhi dekh legi.`;

// Uppercase, strip all whitespace, collapse repeated dashes; O→0 / I→1 only in
// the tail after a 'PIN-' prefix (a foreign number's own letters are untouched).
export function normalizeLrNumber(raw: string): string {
  let s = raw.toUpperCase().replace(/\s+/g, "").replace(/-{2,}/g, "-");
  if (s.startsWith("PIN-")) {
    s = "PIN-" + s.slice(4).replace(/O/g, "0").replace(/I/g, "1");
  }
  return s;
}

// Typed-fallback shape check: MUST contain a digit so "HAAN"/"NAHI" never match.
export function looksLikeLrNumber(text: string): boolean {
  const s = text.trim().toUpperCase();
  return /^(PIN-)?[A-Z0-9-]{4,20}$/.test(s) && /\d/.test(s);
}

// Levenshtein distance <= 1: same length with exactly one differing char, or
// lengths differ by 1 with a single insertion/deletion.
function dist1(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff === 1;
  }
  if (Math.abs(a.length - b.length) !== 1) return false;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; }
    else if (!skipped) { skipped = true; j++; }
    else return false;
  }
  return true;
}

async function buildStatusReply(deps: DocFlowDeps, lr: Lr): Promise<string> {
  const load = lr.loadId ? await deps.loadsRepo.getLoad(lr.loadId) : null;
  const demand = lr.loadId ? await deps.demandRepo.findByLoadId(lr.loadId) : null;
  const from = load?.fromLocation ?? "?";
  const to = load?.toLocation ?? "?";
  let suffix = "";
  if (demand?.status === "CANCELLED") suffix = " · trip CANCELLED";
  else if (load?.status === "CLOSED") suffix = " · trip CLOSED";

  if (lr.status === "PAID") {
    const d = lr.paidAt
      ? new Date(lr.paidAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
      : "";
    return `LR ${lr.lrNumber} · ${from}→${to} · PAID on ${d}${suffix}

✅ Is LR ka payment ho chuka hai. Koi sawaal ho to yahin poochein 🙏`;
  }
  return `LR ${lr.lrNumber} · ${from}→${to} · UNPAID — payment under process${suffix}

⏳ Payment process mein hai — release hote hi main yahin message karunga 💰`;
}

type VisionFields = {
  billedTotalInr: number | null;
  vehicleNo: string | null;
  from: string | null;
  to: string | null;
  docDate: string | null;
  paidStampSeen: boolean;
};

// Core LR lookup/mapping/creation logic shared by the media and typed-text
// entry points. Never touches driver_docs — callers with media wrap the
// result into a docs.upsert; the typed path has no media to store.
async function resolveLr(
  deps: DocFlowDeps,
  rawNumber: string,
  owner: Owner,
  phone: string,
  extra: VisionFields,
  opts: { allowCreate: boolean },
): Promise<{ reply: string; lr: Lr | null }> {
  const normalized = normalizeLrNumber(rawNumber);
  let lr = await deps.lrsRepo.getByNumber(normalized);

  // PIN-shaped and not found exactly → fuzzy match against this driver's own LRs.
  if (!lr && normalized.startsWith("PIN-")) {
    const mine = await deps.lrsRepo.listByOwner(owner.id);
    lr = mine.find((x) => dist1(x.lrNumber, normalized)) ?? null;
  }

  if (lr) {
    if (lr.ownerId && lr.ownerId !== owner.id) {
      await deps.lrsRepo.appendNote(lr.id, `wrong-driver claim from ${phone}`);
      await deps.lrsRepo.setNeedsReview(lr.id, true);
      return { reply: WRONG_DRIVER, lr };
    }
    if (!lr.ownerId) {
      const demand = lr.loadId ? await deps.demandRepo.findByLoadId(lr.loadId) : null;
      if (demand?.winningOwnerId === owner.id) {
        await deps.lrsRepo.mapOwner(lr.id, owner.id);
        lr = { ...lr, ownerId: owner.id };
      } else {
        // Not confirmed as this driver's trip — same "check with us" treatment as
        // a wrong-driver claim (spec: "else flag", no distinct copy given).
        await deps.lrsRepo.appendNote(lr.id, `wrong-driver claim from ${phone}`);
        await deps.lrsRepo.setNeedsReview(lr.id, true);
        return { reply: WRONG_DRIVER, lr };
      }
    }
    if (lr.status === "UNPAID" && extra.paidStampSeen) {
      await deps.lrsRepo.appendNote(lr.id, "claims paid");
    }
    return { reply: await buildStatusReply(deps, lr), lr };
  }

  if (normalized.startsWith("PIN-")) {
    return { reply: FUZZY_NOT_FOUND, lr: null };
  }

  // Typed text never mints a load — only a photo's OCR'd fields are trustworthy
  // enough to found a new load/lr on. A typed foreign number just gets "not found".
  if (!opts.allowCreate) {
    return { reply: typedForeignNotFound(normalized), lr: null };
  }

  // Foreign number: create a load + lr from the OCR'd fields, rate-capped per driver/day.
  const count = await deps.lrsRepo.countCreatedToday(owner.id);
  if (count >= deps.config.lrCreateDailyCap) {
    return { reply: overCap(normalized), lr: null };
  }

  try {
    const load = await deps.loadsRepo.createLoad({
      fromLocation: extra.from ?? "Unknown",
      toLocation: extra.to ?? "Unknown",
      vehicleType: extra.vehicleNo ?? "unknown",
      pickupDate: extra.docDate ?? new Date().toISOString().slice(0, 10),
      fixedPriceInr: extra.billedTotalInr ?? 1, // LoadInputSchema requires > 0
      createdBy: `driver_upload:${owner.id}`,
    });
    const newLr = await deps.lrsRepo.create({
      lrNumber: normalized,
      loadId: load.id,
      ownerId: owner.id,
      source: "driver_upload",
      needsReview: true,
    });
    return { reply: foreignCreated(normalized), lr: newLr };
  } catch (e: any) {
    if (e?.code !== "23505") throw e;
    // Race: another call minted this number first — reply with its status instead.
    const existing = await deps.lrsRepo.getByNumber(normalized);
    return { reply: existing ? await buildStatusReply(deps, existing) : foreignCreated(normalized), lr: existing };
  }
}

// ---- invoice branch copy — VERBATIM per spec ----
const NO_TRIP = `Which LR is this invoice for? Please type the LR number.

🧾 Ye invoice kis trip ka hai? Uska *LR number type kar dein* (jaise PIN-ABC123) taaki main sahi trip se jod sakun.`;
const NO_TOTAL = `Couldn't read the invoice amount — please type the amount (e.g. 16500 or 16.5k).

😕 Bill ka total amount padh nahi paya — bas *amount type kar dein* (jaise 16500 ya 16.5k).`;
const invoiceMatch = (n: number) => `🧾 Invoice received: ${inr(n)} — matches the agreed freight.

✅ Sab sahi hai — amount tay kiye gaye bhade se match karta hai. Team ko mil gaya hai.`;
const invoiceDispute = (billed: number, agreed: number, diff: number) =>
  `🧾 Invoice: ${inr(billed)} vs agreed ${inr(agreed)} — difference ${inr(diff)} flagged for review.

⚠️ Amount tay kiye gaye bhade se alag hai, isliye team review karegi. Jald update milega 🙏`;
const guessConfirmBody = (from: string, to: string, agreed: number) =>
  `Is this invoice for ${from}→${to} · ${inr(agreed)}? `;

type InvoiceCompare = {
  billedInr: number | null;
  varianceInr: number | null;
  dispute: DriverDoc["dispute"];
  reply: string;
};

// Exact match ⇒ NONE; no tolerance in v1 (spec §Invoice). variance_inr is signed
// (billed - agreed); the reply always shows the absolute difference.
function compareInvoice(billed: number | null, agreed: number): InvoiceCompare {
  if (billed == null) return { billedInr: null, varianceInr: null, dispute: "NONE", reply: NO_TOTAL };
  if (billed === agreed) return { billedInr: billed, varianceInr: 0, dispute: "NONE", reply: invoiceMatch(billed) };
  const variance = billed - agreed;
  return { billedInr: billed, varianceInr: variance, dispute: "DISPUTED", reply: invoiceDispute(billed, agreed, Math.abs(variance)) };
}

// Sends the compare reply and, on NO_TOTAL specifically, parks the driver in
// AWAIT_INVOICE_AMOUNT (ctx docId/loadId) so a typed number resumes the
// compare instead of the message getting silently dropped.
async function afterInvoiceReply(
  deps: DocFlowDeps, phone: string, docId: string, loadId: string | null, cmp: InvoiceCompare,
): Promise<void> {
  if (cmp.reply === NO_TOTAL) {
    await deps.sessions.upsert({ phone, role: "driver", state: "AWAIT_INVOICE_AMOUNT", ctx: { docId, loadId } });
  } else {
    await deps.sessions.clear(phone);
  }
  await deps.interakt.sendText(phone, cmp.reply);
}

// Direct match (OCR'd lr_number resolved, or a guess just confirmed): compute
// agreed price, score the invoice against it, upsert the doc, tell the driver.
async function scoreAndUpsertInvoice(
  deps: DocFlowDeps, owner: Owner, phone: string, mediaUrl: string, extracted: Record<string, unknown>,
  load: Load, lrId: string | null, billed: number | null,
): Promise<void> {
  const demand = await deps.demandRepo.findByLoadId(load.id);
  const agreed = demand?.lockedPriceInr ?? load.fixedPriceInr;
  const cmp = compareInvoice(billed, agreed);
  const doc = await deps.docsRepo.upsert({
    ownerId: owner.id, phone, loadId: load.id, lrId, kind: "invoice", mediaUrl, extracted,
    billedInr: cmp.billedInr, varianceInr: cmp.varianceInr, dispute: cmp.dispute,
  });
  await afterInvoiceReply(deps, phone, doc.id, load.id, cmp);
}

async function resolveInvoice(deps: DocFlowDeps, m: WaInbound, owner: Owner, doc: VisionDoc): Promise<void> {
  const mediaUrl = m.mediaUrl!;
  const extracted = doc as unknown as Record<string, unknown>;

  // 1. OCR'd lr_number → lr → load (direct match, no confirmation needed) —
  // but only when the LR actually belongs to this sender. An LR mapped to a
  // different driver must never echo the agreed price or get linked here;
  // fall through to the guess/NO_TRIP path as if the ref hadn't matched.
  if (doc.lrNumber) {
    const lr = await deps.lrsRepo.getByNumber(normalizeLrNumber(doc.lrNumber));
    if (lr?.loadId && (!lr.ownerId || lr.ownerId === owner.id)) {
      const load = await deps.loadsRepo.getLoad(lr.loadId);
      if (load) {
        await scoreAndUpsertInvoice(deps, owner, m.from, mediaUrl, extracted, load, lr.id, doc.billedTotalInr);
        return;
      }
    }
  }

  // 2. No ref (or it didn't resolve) → guess the driver's most recent BOOKED load.
  const guess = await deps.loadsRepo.latestBookedByOwner(owner.id);
  if (!guess) {
    await deps.docsRepo.upsert({
      ownerId: owner.id, phone: m.from, kind: "invoice", mediaUrl, extracted, billedInr: doc.billedTotalInr,
    });
    await deps.interakt.sendText(m.from, NO_TRIP);
    return;
  }

  const demand = await deps.demandRepo.findByLoadId(guess.id);
  const agreed = demand?.lockedPriceInr ?? guess.fixedPriceInr;
  const pending = await deps.docsRepo.upsert({
    ownerId: owner.id, phone: m.from, kind: "invoice", mediaUrl, extracted, billedInr: doc.billedTotalInr,
  });
  const opts = await deps.interakt.sendButtons(m.from, guessConfirmBody(guess.fromLocation, guess.toLocation, agreed), [
    { id: `invy:${pending.id}`, title: "Yes" },
    { id: `invn:${pending.id}`, title: "No" },
  ]);
  await deps.sessions.upsert({
    phone: m.from, role: "driver", state: "CONFIRM_INVOICE_TRIP",
    ctx: { docId: pending.id, loadId: guess.id }, lastOptions: opts,
  });
}

// Driver-flow calls this on any reply while a CONFIRM_INVOICE_TRIP session is
// live; false means the reply isn't one of ours (caller falls through).
export async function handleInvoiceConfirm(deps: DocFlowDeps, m: WaInbound, session: WaSession | null): Promise<boolean> {
  if (!session || session.state !== "CONFIRM_INVOICE_TRIP" || m.kind !== "reply" || !m.replyId) return false;
  const match = /^(invy|invn):(.+)$/.exec(m.replyId);
  if (!match) return false;
  const [, verb, docId] = match;
  if (docId !== String(session.ctx?.docId ?? "")) return false; // stale button from an older invoice

  if (verb === "invn") {
    await deps.sessions.clear(m.from);
    await deps.interakt.sendText(m.from, NO_TRIP);
    return true;
  }

  const loadId = String(session.ctx?.loadId ?? "");
  const load = loadId ? await deps.loadsRepo.getLoad(loadId) : null;
  if (!load) {
    await deps.sessions.clear(m.from);
    await deps.interakt.sendText(m.from, NO_TRIP);
    return true;
  }
  const [lr, demand, pendingDoc] = await Promise.all([
    deps.lrsRepo.getByLoad(load.id),
    deps.demandRepo.findByLoadId(load.id),
    deps.docsRepo.getById(docId),
  ]);
  const agreed = demand?.lockedPriceInr ?? load.fixedPriceInr;
  const cmp = compareInvoice(pendingDoc?.billedInr ?? null, agreed);
  await deps.docsRepo.linkInvoice(docId, { loadId: load.id, lrId: lr?.id ?? null, billedInr: cmp.billedInr, varianceInr: cmp.varianceInr, dispute: cmp.dispute });
  await afterInvoiceReply(deps, m.from, docId, load.id, cmp);
  return true;
}

// Resumes an invoice compare after the driver TYPES the amount we couldn't
// read off the photo (NO_TOTAL ask). docId's row already carries load_id (set
// before the NO_TOTAL reply went out in both callers above) — reuse linkInvoice
// so a same-lr collision merges the same way a normal confirm would.
export async function applyTypedInvoiceAmount(
  deps: DocFlowDeps, docId: string, amountInr: number, phone: string,
): Promise<string> {
  const doc = await deps.docsRepo.getById(docId);
  if (!doc?.loadId) return NO_TRIP;
  const load = await deps.loadsRepo.getLoad(doc.loadId);
  if (!load) return NO_TRIP;
  const demand = await deps.demandRepo.findByLoadId(load.id);
  const agreed = demand?.lockedPriceInr ?? load.fixedPriceInr;
  const cmp = compareInvoice(amountInr, agreed);
  await deps.docsRepo.linkInvoice(docId, { loadId: load.id, lrId: doc.lrId, billedInr: cmp.billedInr, varianceInr: cmp.varianceInr, dispute: cmp.dispute });
  return cmp.reply;
}

export async function handleDriverMedia(deps: DocFlowDeps, m: WaInbound, owner: Owner): Promise<void> {
  const say = (t: string) => deps.interakt.sendText(m.from, t);
  const mediaUrl = m.mediaUrl;
  if (!mediaUrl) return; // ponytail: caller only invokes this for kind==='media'

  const storeUnprocessed = (extracted: Record<string, unknown> = {}) =>
    deps.docsRepo.upsert({ ownerId: owner.id, phone: m.from, kind: "unprocessed", mediaUrl, extracted });

  const result = await deps.vision.extract(mediaUrl);
  if (!result.ok) {
    if (result.reason === "too_large") {
      await storeUnprocessed();
      await say(TOO_LARGE);
      return;
    }
    await storeUnprocessed();
    await say(UNREADABLE);
    return;
  }

  const doc = result.doc;
  if (doc.confidence < 0.5) {
    await storeUnprocessed(doc as unknown as Record<string, unknown>);
    await say(UNREADABLE);
    return;
  }

  if (doc.docType === "other") {
    await deps.docsRepo.upsert({ ownerId: owner.id, phone: m.from, kind: "other", mediaUrl, extracted: doc as unknown as Record<string, unknown> });
    await say(NON_FREIGHT);
    return;
  }

  if (doc.docType === "invoice") {
    await resolveInvoice(deps, m, owner, doc);
    return;
  }

  // docType === "lr"
  if (!doc.lrNumber) {
    await storeUnprocessed(doc as unknown as Record<string, unknown>);
    await say(UNREADABLE);
    return;
  }

  // Shaky read (photo quality): confirm the number with the driver BEFORE acting
  // on it — a mis-read number could show someone else's status or mint a junk LR.
  if (doc.confidence < 0.7) {
    const normalized = normalizeLrNumber(doc.lrNumber);
    await storeUnprocessed(doc as unknown as Record<string, unknown>);
    const opts = await deps.interakt.sendButtons(
      m.from,
      `📷 Photo thodi dhundhli hai. Maine LR number *${normalized}* padha — sahi hai?`,
      [
        { id: `lrok:${normalized}`, title: "✅ Sahi hai" },
        { id: "lrno:x", title: "❌ Galat hai" },
      ],
    );
    await deps.sessions.upsert({
      phone: m.from, role: "driver", state: "CONFIRM_LR_READ",
      ctx: {
        lrNumber: normalized, mediaUrl,
        fields: {
          billedTotalInr: doc.billedTotalInr, vehicleNo: doc.vehicleNo, from: doc.from,
          to: doc.to, docDate: doc.docDate, paidStampSeen: doc.paidStampSeen,
        },
      },
      lastOptions: opts,
    });
    return;
  }

  const { reply, lr } = await resolveLr(deps, doc.lrNumber, owner, m.from, {
    billedTotalInr: doc.billedTotalInr, vehicleNo: doc.vehicleNo, from: doc.from, to: doc.to,
    docDate: doc.docDate, paidStampSeen: doc.paidStampSeen,
  }, { allowCreate: true });
  await deps.docsRepo.upsert({
    ownerId: owner.id, phone: m.from, loadId: lr?.loadId ?? null, lrId: lr?.id ?? null,
    kind: "lr", mediaUrl, extracted: doc as unknown as Record<string, unknown>,
    billedInr: doc.billedTotalInr ?? null, dispute: "NONE",
  });
  await say(reply);
}

// Buffer/email entry point: same OCR'd-doc branching as handleDriverMedia,
// minus anything that needs an interactive WA button. Email has no buttons to
// tap, so the two button-driven sub-flows collapse to a plain typed-number
// ask: marginal-confidence LR reads (0.5–0.7) skip CONFIRM_LR_READ and go
// straight to UNREADABLE ("type the LR number"); an invoice with no directly
// resolvable LR ref skips the guess/confirm-trip prompt and goes straight to
// NO_TRIP (same ask, invoice-flavored copy) instead of parking a
// WA-only session. driver_docs.media_url = sourceRef (e.g.
// `email:<messageId>/<filename>`), phone = owner.phone (docs/notes just need
// an owner identifier, not a reply address).
export async function handleDriverDocBuffer(
  deps: DocFlowDeps, owner: Owner, replyFn: (text: string) => Promise<void>,
  buffer: Buffer, mime: string, sourceRef: string,
): Promise<void> {
  const phone = owner.phone;

  const storeUnprocessed = (kind: DriverDoc["kind"] = "unprocessed", extracted: Record<string, unknown> = {}) =>
    deps.docsRepo.upsert({ ownerId: owner.id, phone, kind, mediaUrl: sourceRef, extracted });

  const result = await deps.vision.extractFromBuffer(buffer, mime);
  if (!result.ok) {
    await storeUnprocessed();
    await replyFn(result.reason === "too_large" ? TOO_LARGE : UNREADABLE);
    return;
  }

  const doc = result.doc;
  if (doc.confidence < 0.5) {
    await storeUnprocessed("unprocessed", doc as unknown as Record<string, unknown>);
    await replyFn(UNREADABLE);
    return;
  }

  if (doc.docType === "other") {
    await storeUnprocessed("other", doc as unknown as Record<string, unknown>);
    await replyFn(NON_FREIGHT);
    return;
  }

  if (doc.docType === "invoice") {
    const extracted = doc as unknown as Record<string, unknown>;
    const lr = doc.lrNumber ? await deps.lrsRepo.getByNumber(normalizeLrNumber(doc.lrNumber)) : null;
    const load = lr?.loadId && (!lr.ownerId || lr.ownerId === owner.id) ? await deps.loadsRepo.getLoad(lr.loadId) : null;
    if (!load) {
      // ponytail: no interactive guess-confirm for buffer entries — ask the
      // driver to type the LR number instead of the WA button flow.
      await deps.docsRepo.upsert({ ownerId: owner.id, phone, kind: "invoice", mediaUrl: sourceRef, extracted, billedInr: doc.billedTotalInr });
      await replyFn(NO_TRIP);
      return;
    }
    const demand = await deps.demandRepo.findByLoadId(load.id);
    const agreed = demand?.lockedPriceInr ?? load.fixedPriceInr;
    const cmp = compareInvoice(doc.billedTotalInr, agreed);
    await deps.docsRepo.upsert({
      ownerId: owner.id, phone, loadId: load.id, lrId: lr!.id, kind: "invoice", mediaUrl: sourceRef, extracted,
      billedInr: cmp.billedInr, varianceInr: cmp.varianceInr, dispute: cmp.dispute,
    });
    await replyFn(cmp.reply);
    return;
  }

  // docType === "lr"
  if (!doc.lrNumber) {
    await storeUnprocessed("unprocessed", doc as unknown as Record<string, unknown>);
    await replyFn(UNREADABLE);
    return;
  }

  if (doc.confidence < 0.7) {
    // ponytail: shaky read — WA asks via CONFIRM_LR_READ buttons; buffer
    // entries have none, so just ask the driver to type the number.
    await storeUnprocessed("unprocessed", doc as unknown as Record<string, unknown>);
    await replyFn(UNREADABLE);
    return;
  }

  const { reply, lr } = await resolveLr(deps, doc.lrNumber, owner, phone, {
    billedTotalInr: doc.billedTotalInr, vehicleNo: doc.vehicleNo, from: doc.from, to: doc.to,
    docDate: doc.docDate, paidStampSeen: doc.paidStampSeen,
  }, { allowCreate: true });
  await deps.docsRepo.upsert({
    ownerId: owner.id, phone, loadId: lr?.loadId ?? null, lrId: lr?.id ?? null,
    kind: "lr", mediaUrl: sourceRef, extracted: doc as unknown as Record<string, unknown>,
    billedInr: doc.billedTotalInr ?? null, dispute: "NONE",
  });
  await replyFn(reply);
}

// Driver-flow calls this while a CONFIRM_LR_READ session is live (shaky vision
// read awaiting the driver's confirmation). Handles button taps AND typed
// haan/nahi/corrected-number; false = not ours, caller falls through. Media
// always falls through so a re-sent (better) photo restarts extraction.
export async function handleLrReadConfirm(
  deps: DocFlowDeps, m: WaInbound, session: WaSession | null, owner: Owner,
): Promise<boolean> {
  if (!session || session.state !== "CONFIRM_LR_READ" || m.kind === "media") return false;
  const ctxNumber = String(session.ctx?.lrNumber ?? "");
  const mediaUrl = String(session.ctx?.mediaUrl ?? "");
  const fields = (session.ctx?.fields ?? {
    billedTotalInr: null, vehicleNo: null, from: null, to: null, docDate: null, paidStampSeen: false,
  }) as VisionFields;

  async function proceed(withNumber: string, allowCreate: boolean) {
    await deps.sessions.clear(m.from);
    const { reply, lr } = await resolveLr(deps, withNumber, owner, m.from, fields, { allowCreate });
    if (mediaUrl) {
      await deps.docsRepo.upsert({
        ownerId: owner.id, phone: m.from, loadId: lr?.loadId ?? null, lrId: lr?.id ?? null,
        kind: "lr", mediaUrl, extracted: { lrNumber: withNumber, ...fields }, dispute: "NONE",
      });
    }
    await deps.interakt.sendText(m.from, reply);
  }

  if (m.kind === "reply" && m.replyId) {
    if (m.replyId === `lrok:${ctxNumber}` && ctxNumber) {
      await proceed(ctxNumber, true);
      return true;
    }
    if (m.replyId.startsWith("lrno:")) {
      await deps.sessions.clear(m.from);
      await deps.interakt.sendText(
        m.from,
        "Koi baat nahi 👍 LR par likha number *type kar dein* (jaise PIN-ABC123), ya saaf photo dobara bhejein.",
      );
      return true;
    }
    return false;
  }

  const text = (m.text ?? "").trim();
  if (looksLikeLrNumber(text)) {
    // driver typed the corrected number — trust it, but typed never creates
    await proceed(text, false);
    return true;
  }
  const intent = parseIntent(text);
  if (intent.kind === "yes" && ctxNumber) {
    await proceed(ctxNumber, true);
    return true;
  }
  if (intent.kind === "no") {
    await deps.sessions.clear(m.from);
    await deps.interakt.sendText(m.from, `Koi baat nahi 👍 LR par likha number *type kar dein* (jaise PIN-ABC123), ya saaf photo dobara bhejein.`);
    return true;
  }
  await deps.interakt.sendText(m.from, `Maine *${ctxNumber}* padha tha — ✅ Sahi hai ya ❌ Galat hai button dabayein, ya sahi number type kar dein.`);
  return true;
}

// Typed LR numbers hit the same lookup (spec: "checked only AFTER the live-offer
// intents"). Returns false when the text isn't LR-shaped so the caller falls through.
export async function handleTypedLr(deps: DocFlowDeps, text: string, owner: Owner, phone: string): Promise<boolean> {
  if (!looksLikeLrNumber(text)) return false;
  const { reply } = await resolveLr(deps, text, owner, phone, {
    billedTotalInr: null, vehicleNo: null, from: null, to: null, docDate: null, paidStampSeen: false,
  }, { allowCreate: false });
  await deps.interakt.sendText(phone, reply);
  return true;
}
