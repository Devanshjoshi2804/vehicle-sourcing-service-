import { FastifyInstance } from "fastify";
import { LoadsRepo } from "./loads.repo.js";
import { LoadInputSchema } from "./loads.schema.js";
import { OwnersRepo } from "../owners/owners.repo.js";
import { matchOwners } from "../matcher/matcher.js";

export function registerLoadRoutes(
  app: FastifyInstance,
  repo: LoadsRepo,
  ownersRepo: OwnersRepo,
  preHandler: any,
) {
  app.post("/loads", { preHandler }, async (req, reply) => {
    const parsed = LoadInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return reply.code(201).send(await repo.createLoad(parsed.data));
  });

  app.get<{ Params: { id: string } }>("/loads/:id", { preHandler }, async (req, reply) => {
    const load = await repo.getLoad(req.params.id);
    if (!load) return reply.code(404).send({ error: "not found" });
    return load;
  });

  app.post<{ Params: { id: string } }>("/loads/:id/close", { preHandler }, async (req, reply) => {
    const load = await repo.getLoad(req.params.id);
    if (!load) return reply.code(404).send({ error: "not found" });
    await repo.setStatus(req.params.id, "CLOSED");
    return { status: "CLOSED" };
  });

  app.get<{ Params: { id: string } }>(
    "/loads/:id/suggested-owners",
    { preHandler },
    async (req, reply) => {
      const load = await repo.getLoad(req.params.id);
      if (!load) return reply.code(404).send({ error: "not found" });
      const owners = await ownersRepo.getActiveOwners();
      return matchOwners(load, owners);
    },
  );
}
