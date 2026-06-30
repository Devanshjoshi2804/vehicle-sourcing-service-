import { FastifyInstance } from "fastify";
import { z } from "zod";
import { QuotesRepo } from "../quotes/quotes.repo.js";
import { CallsRepo } from "../calls/calls.repo.js";
import { CallOrchestrator } from "../calls/orchestrator.js";
import { DemandRepo } from "../demand/demand.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { OwnersRepo } from "../owners/owners.repo.js";
import { GeoResolver } from "../geo/geo.js";
import { sourceDemand } from "../demand/sourcing.js";

// Tolerant on field naming/types: our OVH agent sends camelCase, Plivo CX sends
// snake_case (conversation_id) and may stringify the price / boolean.
const boolish = z.preprocess(
  (v) => (typeof v === "string" ? ["true", "yes", "1"].includes(v.toLowerCase()) : v),
  z.boolean().nullable().optional(),
);
// Voice-sourced price: tolerate "", "15000", "{{quoted_price}}" (unsubstituted),
// "₹15,000" — anything non-numeric becomes null instead of a 400.
const intish = z.preprocess((v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) && n !== 0 ? Math.round(n) : v === 0 || v === "0" ? 0 : null;
}, z.number().int().nullable().optional());
const ReportSchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    conversation_id: z.string().min(1).optional(), // Plivo CX
    available: z.enum(["YES", "NO", "CALLBACK"]).optional(), // inferred if absent
    quotedPriceInr: intish,
    quoted_price_inr: intish,
    quoted_price: intish, // Plivo CX field name
    acceptsFixed: boolish,
    accepts_fixed: boolish,
    vehicleType: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .refine((b) => b.conversationId || b.conversation_id, { message: "conversationId required" });
const PostCallSchema = z.object({
  conversationId: z.string().min(1),
  transcript: z.string().default(""),
});

// Lenient on purpose — voice transcripts (and dashboard tests) are messy:
// caller id can be absent, price may arrive as a string, date as "kal".
const ReportDemandSchema = z.object({
  conversationId: z.string().optional(), // some providers (e.g. Bolna) don't send one
  customerPhone: z.string().optional(),
  fromText: z.string().min(1),
  toText: z.string().min(1),
  vehicleType: z.string().nullable().optional(),
  offeredPriceInr: z.coerce.number().int().nullable().optional(),
  pickupDate: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

// The customer-confirm call (or a manual dispatcher action) reports whether the
// customer accepted the locked price. loadId is the stable key; demandId works too.
const CustomerConfirmSchema = z
  .object({
    loadId: z.string().uuid().optional(),
    demandId: z.string().uuid().optional(),
    conversationId: z.string().optional(),
    accepted: z.boolean(),
  })
  .refine((b) => b.loadId || b.demandId, { message: "loadId or demandId required" });

function secretGuard(secret: string) {
  return async (req: any, reply: any) => {
    // header OR ?secret= (Plivo CX query-param path)
    const provided = req.headers["x-webhook-secret"] || req.query?.secret;
    if (provided !== secret) reply.code(401).send({ error: "unauthorized" });
  };
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: {
    quotesRepo: QuotesRepo;
    callsRepo: CallsRepo;
    orchestrator: CallOrchestrator;
    demandRepo: DemandRepo;
    loadsRepo: LoadsRepo;
    ownersRepo: OwnersRepo;
    geo: GeoResolver;
    secret: string;
  },
) {
  const preHandler = secretGuard(deps.secret);
  const sourcingDeps = {
    demandRepo: deps.demandRepo,
    loadsRepo: deps.loadsRepo,
    ownersRepo: deps.ownersRepo,
    callsRepo: deps.callsRepo,
    orchestrator: deps.orchestrator,
  };

  // Inbound customer call → capture a demand (geocoded). The domino starts here:
  // if the demand is complete (vehicle + price + a matching driver), we AUTO-call
  // drivers immediately. Otherwise it stays NEW for a dispatcher to source by hand.
  app.post("/webhooks/report-demand", { preHandler }, async (req, reply) => {
    const parsed = ReportDemandSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const b = parsed.data;
    // Keep pickupDate only if it's a real YYYY-MM-DD; otherwise stash the raw
    // phrase ("kal", "5 July") in the note so a human can read it on approval.
    const isoDate = b.pickupDate && /^\d{4}-\d{2}-\d{2}$/.test(b.pickupDate) ? b.pickupDate : null;
    const rawDateNote = b.pickupDate && !isoDate ? `date said: ${b.pickupDate}` : null;
    const note = [b.note, rawDateNote].filter(Boolean).join("; ") || null;

    const [fromResolved, toResolved] = await Promise.all([
      deps.geo.resolveLocation(b.fromText),
      deps.geo.resolveLocation(b.toText),
    ]);
    const { created, demand } = await deps.demandRepo.upsertByConversation({
      customerPhone: b.customerPhone || "unknown",
      fromText: b.fromText,
      toText: b.toText,
      fromResolved,
      toResolved,
      vehicleType: b.vehicleType ?? null,
      offeredPriceInr: b.offeredPriceInr ?? null,
      pickupDate: isoDate,
      elConversationId:
        b.conversationId || `ext_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      note,
    });

    // Domino step 1 — auto-source the drivers (only on first capture, only if complete).
    let sourcing: { sourced: boolean; reason?: string; loadId?: string; calledOwners?: number } = {
      sourced: false,
      reason: "duplicate",
    };
    if (created) sourcing = await sourceDemand(sourcingDeps, demand);

    return reply.code(created ? 201 : 200).send({
      created,
      demandId: demand.id,
      sourced: sourcing.sourced,
      calledOwners: sourcing.calledOwners ?? 0,
      sourcingSkipped: sourcing.sourced ? undefined : sourcing.reason,
    });
  });

  app.post("/webhooks/report-availability", { preHandler }, async (req, reply) => {
    // Accept fields from the JSON body OR the URL query string (Plivo CX sends an
    // empty body and puts everything in query params).
    const merged = { ...((req.query as object) ?? {}), ...((req.body as object) ?? {}) };
    const parsed = ReportSchema.safeParse(merged);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const b = parsed.data;
    // normalize camelCase (OVH agent) vs snake_case (Plivo CX), and infer the
    // fields Plivo's report node omits.
    const cid = (b.conversationId || b.conversation_id)!;
    const quotedPriceInr = b.quotedPriceInr ?? b.quoted_price_inr ?? b.quoted_price ?? null;
    const availableProvided = b.available != null;
    const available = b.available ?? "YES"; // node usually only reports when there's an answer
    let acceptsFixed = b.acceptsFixed ?? b.accepts_fixed ?? null;
    if (acceptsFixed === null) {
      // a quoted price means they countered; an explicit YES with no counter means accept.
      if (quotedPriceInr != null) acceptsFixed = false;
      else if (availableProvided && available === "YES") acceptsFixed = true;
    }
    const call = await deps.callsRepo.findByConversationId(cid);
    if (!call) return reply.code(404).send({ error: "unknown conversation" });

    const { created } = await deps.quotesRepo.upsertByConversation({
      loadId: call.loadId,
      ownerId: call.ownerId,
      callAttemptId: call.id,
      elConversationId: cid,
      available,
      quotedPriceInr,
      acceptsFixed,
      vehicleType: b.vehicleType ?? null,
      note: b.note ?? null,
    });

    // Auto follow-up: owner is available but won't take the fixed price, and this was the first offer.
    if (created && call.flow === "offer" && available === "YES" && acceptsFixed === false) {
      await deps.orchestrator.enqueue(call.loadId, [call.ownerId], "fixed_price_followup");
    }

    // Domino step 2 — first driver to ACCEPT the fixed price locks the load. We
    // record the winner, stop dialing everyone else, and stop here: the customer
    // is NOT called yet — the company approves the value first (see /approve-driver).
    if (created && available === "YES" && acceptsFixed === true) {
      const load = await deps.loadsRepo.getLoad(call.loadId);
      const demand = await deps.demandRepo.findByLoadId(call.loadId);
      if (demand) {
        const locked = await deps.demandRepo.lockDriver(
          call.loadId,
          call.ownerId,
          load?.fixedPriceInr ?? quotedPriceInr ?? 0,
        );
        if (locked) {
          await deps.loadsRepo.setStatus(call.loadId, "LOCKED");
          await deps.callsRepo.supersedePending(call.loadId, call.ownerId);
        }
      } else if (load && load.status === "CALLING") {
        // Side-B (dispatcher-posted, no customer): first accepter still locks the
        // load and stops the other calls; the dispatcher closes it.
        await deps.loadsRepo.setStatus(call.loadId, "LOCKED");
        await deps.callsRepo.supersedePending(call.loadId, call.ownerId);
      }
    }
    return reply.code(created ? 201 : 200).send({ created });
  });

  // Domino step 4 — the customer-confirm call (or the manual "customer confirmed"
  // button) reports the customer's answer. Yes → BOOKED; no → DECLINED.
  app.post("/webhooks/customer-confirm", { preHandler }, async (req, reply) => {
    const parsed = CustomerConfirmSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const b = parsed.data;
    const demand = b.demandId
      ? await deps.demandRepo.getById(b.demandId)
      : await deps.demandRepo.findByLoadId(b.loadId!);
    if (!demand) return reply.code(404).send({ error: "unknown demand" });

    if (b.accepted) {
      const booked = await deps.demandRepo.book(demand.id);
      if (booked && demand.loadId) await deps.loadsRepo.setStatus(demand.loadId, "BOOKED");
      return reply.code(booked ? 200 : 409).send({ status: booked?.status ?? demand.status });
    }
    await deps.demandRepo.setStatus(demand.id, "DECLINED");
    if (demand.loadId) await deps.loadsRepo.setStatus(demand.loadId, "CLOSED");
    return { status: "DECLINED" };
  });

  app.post("/webhooks/elevenlabs/post-call", { preHandler }, async (req, reply) => {
    const parsed = PostCallSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const call = await deps.callsRepo.findByConversationId(parsed.data.conversationId);
    if (call) {
      await deps.callsRepo.setStatus(call.id, "DONE", { ended: true });
      await deps.quotesRepo.attachTranscript(parsed.data.conversationId, parsed.data.transcript);
    }
    return { ok: true };
  });
}
