import { FastifyInstance } from "fastify";
import { z } from "zod";
import { QuotesRepo } from "../quotes/quotes.repo.js";
import { CallsRepo } from "../calls/calls.repo.js";
import { CallOrchestrator } from "../calls/orchestrator.js";
import { DemandRepo } from "../demand/demand.repo.js";
import { GeoResolver } from "../geo/geo.js";

const ReportSchema = z.object({
  conversationId: z.string().min(1),
  available: z.enum(["YES", "NO", "CALLBACK"]),
  quotedPriceInr: z.number().int().nullable().optional(),
  acceptsFixed: z.boolean().nullable().optional(),
  vehicleType: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});
const PostCallSchema = z.object({
  conversationId: z.string().min(1),
  transcript: z.string().default(""),
});

const ReportDemandSchema = z.object({
  conversationId: z.string().min(1),
  customerPhone: z.string().min(1),
  fromText: z.string().min(1),
  toText: z.string().min(1),
  vehicleType: z.string().nullable().optional(),
  offeredPriceInr: z.number().int().nullable().optional(),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().nullable().optional(),
});

function secretGuard(secret: string) {
  return async (req: any, reply: any) => {
    if (req.headers["x-webhook-secret"] !== secret) reply.code(401).send({ error: "unauthorized" });
  };
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: {
    quotesRepo: QuotesRepo;
    callsRepo: CallsRepo;
    orchestrator: CallOrchestrator;
    demandRepo: DemandRepo;
    geo: GeoResolver;
    secret: string;
  },
) {
  const preHandler = secretGuard(deps.secret);

  // Inbound customer call → capture a demand request (geocoded), status NEW.
  app.post("/webhooks/report-demand", { preHandler }, async (req, reply) => {
    const parsed = ReportDemandSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const b = parsed.data;
    const [fromResolved, toResolved] = await Promise.all([
      deps.geo.resolveLocation(b.fromText),
      deps.geo.resolveLocation(b.toText),
    ]);
    const { created, demand } = await deps.demandRepo.upsertByConversation({
      customerPhone: b.customerPhone,
      fromText: b.fromText,
      toText: b.toText,
      fromResolved,
      toResolved,
      vehicleType: b.vehicleType ?? null,
      offeredPriceInr: b.offeredPriceInr ?? null,
      pickupDate: b.pickupDate ?? null,
      elConversationId: b.conversationId,
      note: b.note ?? null,
    });
    return reply.code(created ? 201 : 200).send({ created, demandId: demand.id });
  });

  app.post("/webhooks/report-availability", { preHandler }, async (req, reply) => {
    const parsed = ReportSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const b = parsed.data;
    const call = await deps.callsRepo.findByConversationId(b.conversationId);
    if (!call) return reply.code(404).send({ error: "unknown conversation" });

    const { created } = await deps.quotesRepo.upsertByConversation({
      loadId: call.loadId,
      ownerId: call.ownerId,
      callAttemptId: call.id,
      elConversationId: b.conversationId,
      available: b.available,
      quotedPriceInr: b.quotedPriceInr ?? null,
      acceptsFixed: b.acceptsFixed ?? null,
      vehicleType: b.vehicleType ?? null,
      note: b.note ?? null,
    });

    // Auto follow-up: owner is available but won't take the fixed price, and this was the first offer.
    if (created && call.flow === "offer" && b.available === "YES" && b.acceptsFixed === false) {
      await deps.orchestrator.enqueue(call.loadId, [call.ownerId], "fixed_price_followup");
    }

    // Side A: if an owner ACCEPTS the price on a demand-sourced load, confirm the
    // customer (outbound "request accepted" call) and mark the demand CONFIRMED.
    if (created && b.available === "YES" && b.acceptsFixed === true) {
      const demand = await deps.demandRepo.findByLoadId(call.loadId);
      if (demand && demand.status === "SOURCING") {
        await deps.orchestrator.confirmCustomer(call.loadId, demand.customerPhone);
        await deps.demandRepo.setStatus(demand.id, "CONFIRMED");
      }
    }
    return reply.code(created ? 201 : 200).send({ created });
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
