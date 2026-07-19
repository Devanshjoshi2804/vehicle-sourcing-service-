import { FastifyInstance } from "fastify";
import { LrsRepo } from "./lrs.repo.js";
import { DocsRepo } from "./docs.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { DemandRepo } from "../demand/demand.repo.js";
import { OwnersRepo } from "../owners/owners.repo.js";
import { WaSender, inr } from "../wa/wa-sender.js";
import { Mailer } from "../email/mailer.js";

export function registerLrRoutes(
  app: FastifyInstance,
  deps: {
    lrsRepo: LrsRepo;
    docsRepo: DocsRepo;
    loadsRepo: LoadsRepo;
    demandRepo: DemandRepo;
    ownersRepo: OwnersRepo;
    waSender?: WaSender;
    mailer?: Mailer;
  },
  preHandler: any,
) {
  app.get<{ Params: { id: string } }>("/loads/:id/docs", { preHandler }, async (req) => {
    const [lr, docs] = await Promise.all([
      deps.lrsRepo.getByLoad(req.params.id),
      deps.docsRepo.listByLoad(req.params.id),
    ]);
    return { lr, docs };
  });

  app.get("/lrs", { preHandler }, async () => deps.lrsRepo.listNeedsReview());

  app.post<{ Params: { id: string } }>("/lrs/:id/mark-paid", { preHandler }, async (req, reply) => {
    const lr = await deps.lrsRepo.getById(req.params.id);
    if (!lr) return reply.code(404).send({ error: "not found" });
    const paid = await deps.lrsRepo.markPaid(lr.id);
    if (!paid) return reply.code(409).send({ error: "already paid" });

    // best-effort: never let a notify failure undo the payment mark
    try {
      if ((deps.waSender || deps.mailer) && paid.ownerId && paid.loadId) {
        const owners = await deps.ownersRepo.getActiveOwners();
        const owner = owners.find((o) => o.id === paid.ownerId);
        if (owner) {
          const load = await deps.loadsRepo.getLoad(paid.loadId);
          if (load) {
            const demand = await deps.demandRepo.findByLoadId(paid.loadId);
            const agreed = demand?.lockedPriceInr ?? load.fixedPriceInr;
            const body = `💰 Payment released for LR ${paid.lrNumber} (${inr(agreed)}).`;
            if (owner.channel === "email" && owner.email && deps.mailer) {
              await deps.mailer.send(owner.email, `Payment released — LR ${paid.lrNumber}`, body);
            } else if (deps.waSender && owner.channel !== "voice") {
              await deps.waSender.sendText(owner.phone, body);
            }
          }
        }
      }
    } catch {
      /* best-effort */
    }

    return { status: "PAID", paidAt: paid.paidAt };
  });

  app.post<{ Params: { id: string } }>("/docs/:id/resolve-dispute", { preHandler }, async (req, reply) => {
    const doc = await deps.docsRepo.getById(req.params.id);
    if (!doc) return reply.code(404).send({ error: "not found" });
    const resolved = await deps.docsRepo.resolveDispute(doc.id);
    if (!resolved) return reply.code(409).send({ error: `cannot resolve from ${doc.dispute}` });
    return { dispute: "RESOLVED" };
  });
}
