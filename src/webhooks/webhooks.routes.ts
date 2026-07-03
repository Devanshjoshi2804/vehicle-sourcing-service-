import { FastifyInstance } from "fastify";
import { z } from "zod";
import { QuotesRepo } from "../quotes/quotes.repo.js";
import { CallsRepo } from "../calls/calls.repo.js";
import { CallOrchestrator } from "../calls/orchestrator.js";
import { DemandRepo } from "../demand/demand.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { OwnersRepo } from "../owners/owners.repo.js";
import { GeoResolver } from "../geo/geo.js";
import { captureDemand } from "../demand/sourcing.js";
import { recordAvailability } from "../quotes/availability.js";

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
  const captureDeps = { ...sourcingDeps, geo: deps.geo };

  const availabilityDeps = {
    quotesRepo: deps.quotesRepo,
    callsRepo: deps.callsRepo,
    loadsRepo: deps.loadsRepo,
    demandRepo: deps.demandRepo,
    orchestrator: deps.orchestrator,
  };

  const firstOf = (o: any, ...keys: string[]) => {
    for (const k of keys) if (o?.[k] != null && o[k] !== "") return o[k];
    return null;
  };

  // Inbound customer call → capture a demand (geocoded). The domino starts here:
  // if the demand is complete (vehicle + price + a matching driver), we AUTO-call
  // drivers immediately. Otherwise it stays NEW for a dispatcher to source by hand.
  app.post("/webhooks/report-demand", { preHandler }, async (req, reply) => {
    const parsed = ReportDemandSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const b = parsed.data;

    // Domino step 1 — geocode + upsert (idempotent) + auto-source when complete.
    const { created, demand, sourcing } = await captureDemand(captureDeps, {
      customerPhone: b.customerPhone || "unknown",
      fromText: b.fromText,
      toText: b.toText,
      vehicleType: b.vehicleType ?? null,
      offeredPriceInr: b.offeredPriceInr ?? null,
      pickupDate: b.pickupDate ?? null,
      conversationId:
        b.conversationId || `ext_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      channel: "voice",
      note: b.note ?? null,
    });

    return reply.code(created ? 201 : 200).send({
      created,
      demandId: demand.id,
      sourced: sourcing.sourced,
      calledOwners: sourcing.calledOwners ?? 0,
      sourcingSkipped: sourcing.sourced ? undefined : sourcing.reason,
    });
  });

  app.post("/webhooks/report-availability", { preHandler }, async (req, reply) => {
    // TEMP diagnostic: log exactly what the caller sent (body/query/content-type).
    app.log.info(
      {
        ct: req.headers["content-type"],
        cl: req.headers["content-length"],
        ua: req.headers["user-agent"],
        body: req.body,
        query: req.query,
      },
      "[report-avail RAW]",
    );
    // Accept fields from the JSON body OR the URL query string (Plivo CX sends an
    // empty body and puts everything in query params).
    const merged = { ...((req.query as object) ?? {}), ...((req.body as object) ?? {}) };
    const parsed = ReportSchema.safeParse(merged);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const b = parsed.data;
    const r = await recordAvailability(availabilityDeps, {
      cid: b.conversationId || b.conversation_id,
      available: b.available,
      acceptsFixed: b.acceptsFixed ?? b.accepts_fixed,
      quotedPriceInr: b.quotedPriceInr ?? b.quoted_price_inr ?? b.quoted_price,
      vehicleType: b.vehicleType,
      note: b.note,
    });
    if (!r.ok) return reply.code(r.reason === "unknown conversation" ? 404 : 400).send({ error: r.reason });
    return reply.code(r.created ? 201 : 200).send({ created: r.created });
  });

  // Plivo platform Hangup URL callback: fired by Plivo when the call ends, carrying
  // the call fields + the agent's Extract-Variables. This is the reliable path
  // (the in-call HTTP action ships empty requests). Permissive on field names +
  // format; always 200 so Plivo never retries/marks the call failed.
  app.post("/webhooks/plivo-hangup", { preHandler }, async (req, reply) => {
    const raw = req.body as any;
    app.log.info(
      { ct: req.headers["content-type"], body: raw, query: req.query },
      "[plivo-hangup RAW]",
    );
    // Plivo nests the call fields + extracted variables under data.object.event_data,
    // with node-prefixed keys like "Offer Confirmation Agent.quotedpriceinr" and
    // "Start.http.params.conversation_id". Match by the last key segment.
    const ed: Record<string, any> = raw?.data?.object?.event_data ?? raw?.event_data ?? {};
    let cid: any = null;
    let availableRaw: any = null;
    let afRaw: any = null;
    let qpRaw: any = null;
    let note: any = null;
    let vt: any = null;
    for (const [k, v] of Object.entries(ed)) {
      const lk = k.toLowerCase();
      const seg = lk.split(".").pop();
      if (lk.includes("http.params.conversation_id")) cid = v; // OUR id (not Plivo's)
      else if (seg === "available") availableRaw = v;
      else if (seg === "acceptsfixed") afRaw = v;
      else if (seg === "quotedpriceinr") qpRaw = v;
      else if (seg === "note") note = v;
      else if (seg === "vehicle_type") vt = v;
    }
    // fall back to query/body if a non-Plivo caller ever posts flat fields
    const flat = { ...((req.query as object) ?? {}), ...((typeof raw === "object" ? raw : {}) as object) } as any;
    if (!cid) cid = firstOf(flat, "conversationId", "conversation_id");
    if (cid && String(cid).startsWith("{{")) cid = null; // ignore unsubstituted template

    const quotedPriceInr =
      qpRaw != null && qpRaw !== "" ? Number(String(qpRaw).replace(/[^\d.-]/g, "")) || null : null;
    const acceptsFixed =
      afRaw == null
        ? null
        : typeof afRaw === "boolean"
          ? afRaw
          : ["true", "yes", "1"].includes(String(afRaw).toLowerCase());
    const available = availableRaw ? String(availableRaw).toUpperCase() : null;

    const r = await recordAvailability(availabilityDeps, {
      cid,
      available,
      acceptsFixed,
      quotedPriceInr,
      vehicleType: vt,
      note,
    });
    app.log.info({ cid, available, acceptsFixed, quotedPriceInr, result: r }, "[plivo-hangup RESULT]");
    return reply.code(200).send({ ok: r.ok, reason: r.reason });
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
