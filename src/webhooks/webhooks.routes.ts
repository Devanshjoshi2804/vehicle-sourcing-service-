import { FastifyInstance } from "fastify";
import { z } from "zod";
import { QuotesRepo } from "../quotes/quotes.repo.js";
import { CallsRepo } from "../calls/calls.repo.js";
import { CallOrchestrator } from "../calls/orchestrator.js";

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
    secret: string;
  },
) {
  const preHandler = secretGuard(deps.secret);

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
