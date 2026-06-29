import { FastifyInstance } from "fastify";
import { z } from "zod";
import { OwnersRepo } from "./owners.repo.js";
import { OwnerInputSchema } from "./owners.schema.js";

const PatchSchema = OwnerInputSchema.partial().extend({ active: z.boolean().optional() });

export function registerOwnerRoutes(app: FastifyInstance, repo: OwnersRepo, preHandler: any) {
  app.post("/owners", { preHandler }, async (req, reply) => {
    const parsed = OwnerInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return reply.code(201).send(await repo.createOwner(parsed.data));
  });

  app.get("/owners", { preHandler }, async () => repo.listOwners());

  app.patch<{ Params: { id: string } }>("/owners/:id", { preHandler }, async (req, reply) => {
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const updated = await repo.updateOwner(req.params.id, parsed.data);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });
}
