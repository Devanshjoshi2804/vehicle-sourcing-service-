import { FastifyInstance } from "fastify";
import { z } from "zod";
import { DemandRepo, DemandStatus } from "./demand.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { OwnersRepo } from "../owners/owners.repo.js";
import { CallsRepo } from "../calls/calls.repo.js";
import { CallOrchestrator } from "../calls/orchestrator.js";
import { sourceDemand } from "./sourcing.js";

const STATUSES = [
  "NEW",
  "REJECTED",
  "SOURCING",
  "DRIVER_LOCKED",
  "CUSTOMER_PENDING",
  "BOOKED",
  "DECLINED",
  "CANCELLED",
] as const;

const ListQuery = z.object({
  status: z.enum(STATUSES).optional(),
  loadId: z.string().uuid().optional(),
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
    callsRepo: CallsRepo;
    orchestrator: CallOrchestrator;
  },
  preHandler: any,
) {
  const sourcingDeps = {
    demandRepo: deps.demandRepo,
    loadsRepo: deps.loadsRepo,
    ownersRepo: deps.ownersRepo,
    callsRepo: deps.callsRepo,
    orchestrator: deps.orchestrator,
  };

  app.get("/demand", { preHandler }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    return deps.demandRepo.list({ status: q.data.status as DemandStatus | undefined, loadId: q.data.loadId });
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

  // Manual fallback for an incomplete NEW demand the auto-sourcer couldn't handle:
  // fill in the missing fields, then fire driver calls. (Complete demands are
  // already auto-sourced on capture.)
  app.post<{ Params: { id: string } }>("/demand/:id/approve", { preHandler }, async (req, reply) => {
    const parsed = ApproveBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    let d = await deps.demandRepo.getById(req.params.id);
    if (!d) return reply.code(404).send({ error: "not found" });
    if (d.status !== "NEW") return reply.code(409).send({ error: `cannot source from ${d.status}` });

    if (parsed.data.fixedPriceInr || parsed.data.vehicleType || parsed.data.pickupDate) {
      d = (await deps.demandRepo.patchDetails(d.id, {
        vehicleType: parsed.data.vehicleType,
        offeredPriceInr: parsed.data.fixedPriceInr,
        pickupDate: parsed.data.pickupDate,
      })) ?? d;
    }

    const result = await sourceDemand(sourcingDeps, d, { ownerIds: parsed.data.ownerIds });
    if (!result.sourced) return reply.code(400).send({ error: `cannot source: ${result.reason}` });
    return reply.code(202).send({ loadId: result.loadId, calledOwners: result.calledOwners, status: "SOURCING" });
  });

  // Domino step 3 — the company approves the locked driver's value. Only then is
  // the customer called to confirm.
  app.post<{ Params: { id: string } }>("/demand/:id/approve-driver", { preHandler }, async (req, reply) => {
    const d = await deps.demandRepo.getById(req.params.id);
    if (!d) return reply.code(404).send({ error: "not found" });
    const approved = await deps.demandRepo.approveValue(d.id);
    if (!approved) return reply.code(409).send({ error: `cannot approve from ${d.status}` });
    if (approved.loadId) await deps.orchestrator.confirmCustomer(approved.loadId, approved.customerPhone, approved.id);
    return { status: "CUSTOMER_PENDING", loadId: approved.loadId };
  });

  // Domino step 4 (manual) — dispatcher marks the customer confirmed → booked.
  app.post<{ Params: { id: string } }>("/demand/:id/book", { preHandler }, async (req, reply) => {
    const d = await deps.demandRepo.getById(req.params.id);
    if (!d) return reply.code(404).send({ error: "not found" });
    const booked = await deps.demandRepo.book(d.id);
    if (!booked) return reply.code(409).send({ error: `cannot book from ${d.status}` });
    if (booked.loadId) await deps.loadsRepo.setStatus(booked.loadId, "BOOKED");
    return { status: "BOOKED", loadId: booked.loadId };
  });

  // Company rejects the locked driver, or the customer declined: kill the trip.
  app.post<{ Params: { id: string } }>("/demand/:id/cancel", { preHandler }, async (req, reply) => {
    const d = await deps.demandRepo.getById(req.params.id);
    if (!d) return reply.code(404).send({ error: "not found" });
    if (!["SOURCING", "DRIVER_LOCKED", "CUSTOMER_PENDING"].includes(d.status))
      return reply.code(409).send({ error: `cannot cancel from ${d.status}` });
    await deps.demandRepo.setStatus(d.id, "CANCELLED");
    if (d.loadId) await deps.loadsRepo.setStatus(d.loadId, "CLOSED");
    return { status: "CANCELLED" };
  });

  // One-click re-source: reopen the demand and call the matching drivers we
  // haven't already called on this load.
  app.post<{ Params: { id: string } }>("/demand/:id/resource", { preHandler }, async (req, reply) => {
    const d = await deps.demandRepo.getById(req.params.id);
    if (!d) return reply.code(404).send({ error: "not found" });
    if (!["DRIVER_LOCKED", "CUSTOMER_PENDING", "CANCELLED", "SOURCING"].includes(d.status))
      return reply.code(409).send({ error: `cannot re-source from ${d.status}` });

    const calledOwnerIds = d.loadId
      ? [...new Set((await deps.callsRepo.listByLoad(d.loadId)).map((c) => c.ownerId))]
      : [];
    const reopened = (await deps.demandRepo.reopen(d.id)) ?? d;
    const result = await sourceDemand(sourcingDeps, reopened, { excludeOwnerIds: calledOwnerIds });
    if (!result.sourced) return reply.code(400).send({ error: `cannot re-source: ${result.reason}` });
    return reply.code(202).send({ loadId: result.loadId, calledOwners: result.calledOwners, status: "SOURCING" });
  });

  // Accept a specific driver at a specific price (e.g. take their counter). Locks
  // the load to that owner at priceInr and stops calling everyone else — same as an
  // on-call accept, but at a dispatcher-chosen price instead of the fixed one.
  const AcceptBody = z.object({ priceInr: z.coerce.number().int().positive().optional() });
  app.post<{ Params: { id: string; ownerId: string } }>(
    "/loads/:id/owners/:ownerId/accept",
    { preHandler },
    async (req, reply) => {
      const parsed = AcceptBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const { id: loadId, ownerId } = req.params;
      const load = await deps.loadsRepo.getLoad(loadId);
      if (!load) return reply.code(404).send({ error: "load not found" });
      const priceInr = parsed.data.priceInr ?? load.fixedPriceInr;

      const demand = await deps.demandRepo.findByLoadId(loadId);
      if (demand) {
        // race-safe: only locks from SOURCING (nobody else locked first)
        const locked = await deps.demandRepo.lockDriver(loadId, ownerId, priceInr);
        if (!locked) return reply.code(409).send({ error: `cannot accept from ${demand.status}` });
        await deps.loadsRepo.setStatus(loadId, "LOCKED");
        await deps.callsRepo.supersedePending(loadId, ownerId);
        return { status: "DRIVER_LOCKED", ownerId, lockedPriceInr: priceInr };
      }
      // Side-B (dispatcher-posted, no customer): just lock the load to this owner.
      await deps.loadsRepo.setStatus(loadId, "LOCKED");
      await deps.callsRepo.supersedePending(loadId, ownerId);
      return { status: "LOCKED", ownerId, lockedPriceInr: priceInr };
    },
  );

  // Re-negotiate: call this driver back with a NEW offer price (a counter-offer),
  // instead of accepting theirs. The agent pitches priceInr; the driver can accept
  // it on the call, which flows back and locks like any acceptance.
  const ReofferBody = z.object({ priceInr: z.coerce.number().int().positive() });
  app.post<{ Params: { id: string; ownerId: string } }>(
    "/loads/:id/owners/:ownerId/reoffer",
    { preHandler },
    async (req, reply) => {
      const parsed = ReofferBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const { id: loadId, ownerId } = req.params;
      const load = await deps.loadsRepo.getLoad(loadId);
      if (!load) return reply.code(404).send({ error: "load not found" });
      await deps.orchestrator.enqueue(loadId, [ownerId], "fixed_price_followup", {
        offerPriceInr: parsed.data.priceInr,
      });
      return reply.code(202).send({ queued: 1, offeredPriceInr: parsed.data.priceInr });
    },
  );
}
