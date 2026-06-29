import { FastifyInstance } from "fastify";
import { z } from "zod";
import { DemandRepo, DemandStatus } from "./demand.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { OwnersRepo } from "../owners/owners.repo.js";
import { CallOrchestrator } from "../calls/orchestrator.js";
import { matchOwners } from "../matcher/matcher.js";

const ListQuery = z.object({
  status: z.enum(["NEW", "REJECTED", "APPROVED", "SOURCING", "CONFIRMED"]).optional(),
});

const ApproveBody = z.object({
  fixedPriceInr: z.number().int().positive().optional(),
  vehicleType: z.string().min(1).optional(),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ownerIds: z.array(z.string().uuid()).optional(),
});

export function registerDemandRoutes(
  app: FastifyInstance,
  deps: {
    demandRepo: DemandRepo;
    loadsRepo: LoadsRepo;
    ownersRepo: OwnersRepo;
    orchestrator: CallOrchestrator;
  },
  preHandler: any,
) {
  app.get("/demand", { preHandler }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    return deps.demandRepo.list({ status: q.data.status as DemandStatus | undefined });
  });

  app.get<{ Params: { id: string } }>("/demand/:id", { preHandler }, async (req, reply) => {
    const d = await deps.demandRepo.getById(req.params.id);
    if (!d) return reply.code(404).send({ error: "not found" });
    return d;
  });

  app.post<{ Params: { id: string } }>("/demand/:id/reject", { preHandler }, async (req, reply) => {
    const d = await deps.demandRepo.getById(req.params.id);
    if (!d) return reply.code(404).send({ error: "not found" });
    if (d.status !== "NEW") return reply.code(409).send({ error: `cannot reject from ${d.status}` });
    await deps.demandRepo.setStatus(d.id, "REJECTED");
    return { status: "REJECTED" };
  });

  // Approve → create a load from the demand, then fan out Side-B calls to
  // matching owners (or an explicit owner list). The customer is confirmed
  // later, only once an owner accepts (handled in the report-availability hook).
  app.post<{ Params: { id: string } }>("/demand/:id/approve", { preHandler }, async (req, reply) => {
    const parsed = ApproveBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const d = await deps.demandRepo.getById(req.params.id);
    if (!d) return reply.code(404).send({ error: "not found" });
    if (d.status !== "NEW") return reply.code(409).send({ error: `cannot approve from ${d.status}` });

    const price = parsed.data.fixedPriceInr ?? d.offeredPriceInr;
    const vehicleType = parsed.data.vehicleType ?? d.vehicleType;
    const pickupDate = parsed.data.pickupDate ?? d.pickupDate;
    if (!price) return reply.code(400).send({ error: "fixedPriceInr required (no offered price on demand)" });
    if (!vehicleType) return reply.code(400).send({ error: "vehicleType required (none on demand)" });
    if (!pickupDate) return reply.code(400).send({ error: "pickupDate required (none on demand)" });

    const fromLocation = d.fromResolved?.city || d.fromResolved?.canonical || d.fromText;
    const toLocation = d.toResolved?.city || d.toResolved?.canonical || d.toText;

    const load = await deps.loadsRepo.createLoad({
      fromLocation,
      toLocation,
      vehicleType,
      pickupDate,
      fixedPriceInr: price,
      createdBy: `demand:${d.id}`,
    });
    await deps.demandRepo.attachLoad(d.id, load.id);
    await deps.demandRepo.setStatus(d.id, "SOURCING");

    let ownerIds = parsed.data.ownerIds;
    if (!ownerIds) {
      const owners = await deps.ownersRepo.getActiveOwners();
      ownerIds = matchOwners(load, owners).map((m) => m.owner.id);
    }
    if (ownerIds.length) await deps.orchestrator.enqueue(load.id, ownerIds, "offer");

    return reply.code(202).send({ loadId: load.id, calledOwners: ownerIds.length, status: "SOURCING" });
  });
}
