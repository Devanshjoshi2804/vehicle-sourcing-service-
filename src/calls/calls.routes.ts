import { FastifyInstance } from "fastify";
import { z } from "zod";
import { CallOrchestrator } from "./orchestrator.js";
import { CallsRepo } from "./calls.repo.js";

const FireSchema = z.object({ ownerIds: z.array(z.string().uuid()).min(1) });

export function registerCallRoutes(
  app: FastifyInstance,
  orchestrator: CallOrchestrator,
  callsRepo: CallsRepo,
  preHandler: any,
) {
  app.post<{ Params: { id: string } }>("/loads/:id/call", { preHandler }, async (req, reply) => {
    const parsed = FireSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const result = await orchestrator.enqueue(req.params.id, parsed.data.ownerIds, "offer");
      return reply.code(202).send(result);
    } catch {
      return reply.code(404).send({ error: "load not found" });
    }
  });

  app.get<{ Params: { id: string } }>("/loads/:id/calls", { preHandler }, async (req) =>
    callsRepo.listByLoad(req.params.id),
  );
}
