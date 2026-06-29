import { FastifyInstance } from "fastify";
import { z } from "zod";
import { QuotesRepo, Availability } from "./quotes.repo.js";
import { CallOrchestrator } from "../calls/orchestrator.js";

const QuerySchema = z.object({
  available: z.enum(["YES", "NO", "CALLBACK"]).optional(),
  acceptsFixed: z.enum(["true", "false"]).optional(),
});

export function registerQuoteRoutes(
  app: FastifyInstance,
  deps: { quotesRepo: QuotesRepo; orchestrator: CallOrchestrator },
  preHandler: any,
) {
  app.get<{ Params: { id: string } }>("/loads/:id/quotes", { preHandler }, async (req, reply) => {
    const q = QuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const filter: { available?: Availability; acceptsFixed?: boolean } = {};
    if (q.data.available) filter.available = q.data.available;
    if (q.data.acceptsFixed) filter.acceptsFixed = q.data.acceptsFixed === "true";
    return deps.quotesRepo.listByLoad(req.params.id, filter);
  });

  app.post<{ Params: { id: string; ownerId: string } }>(
    "/loads/:id/owners/:ownerId/followup",
    { preHandler },
    async (req, reply) => {
      try {
        const r = await deps.orchestrator.enqueue(
          req.params.id,
          [req.params.ownerId],
          "fixed_price_followup",
        );
        return reply.code(202).send(r);
      } catch {
        return reply.code(404).send({ error: "load not found" });
      }
    },
  );
}
