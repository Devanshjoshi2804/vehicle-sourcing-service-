import { DemandRepo, DemandRequest } from "./demand.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { OwnersRepo } from "../owners/owners.repo.js";
import { CallsRepo } from "../calls/calls.repo.js";
import { CallOrchestrator } from "../calls/orchestrator.js";
import { matchOwners } from "../matcher/matcher.js";
import { Owner } from "../owners/owners.schema.js";

export type SourcingDeps = {
  demandRepo: DemandRepo;
  loadsRepo: LoadsRepo;
  ownersRepo: OwnersRepo;
  callsRepo: CallsRepo;
  orchestrator: CallOrchestrator;
};

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

const isIsoDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export type SourcingPlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      load: { fromLocation: string; toLocation: string; vehicleType: string; pickupDate: string; fixedPriceInr: number };
      ownerIds: string[];
    };

// A demand is "complete enough" to auto-source only when it has a vehicle type, a
// price, and at least one active driver on its lane + vehicle. A fuzzy/absent
// pickup date is fine — we default it to tomorrow (the raw phrase is kept in the
// demand note). Anything short of that stays NEW for a human to handle.
export function planSourcing(demand: DemandRequest, owners: Owner[]): SourcingPlan {
  const fixedPriceInr = demand.offeredPriceInr;
  const vehicleType = demand.vehicleType;
  if (!fixedPriceInr) return { ok: false, reason: "no price on demand" };
  if (!vehicleType) return { ok: false, reason: "no vehicle type on demand" };

  const fromLocation = demand.fromResolved?.city || demand.fromResolved?.canonical || demand.fromText;
  const toLocation = demand.toResolved?.city || demand.toResolved?.canonical || demand.toText;
  const pickupDate = isIsoDate(demand.pickupDate) ? demand.pickupDate : tomorrow();

  const matched = matchOwners({ fromLocation, toLocation, vehicleType }, owners);
  if (matched.length === 0) return { ok: false, reason: "no matching drivers on this lane" };

  return {
    ok: true,
    load: { fromLocation, toLocation, vehicleType, pickupDate, fixedPriceInr },
    ownerIds: matched.map((m) => m.owner.id),
  };
}

// Create the load (once) and fire offer calls to the matching drivers, marking the
// demand SOURCING. Used by auto-source (inbound webhook), the manual approve
// fallback, and re-source. `excludeOwnerIds` lets re-source skip already-called
// drivers; `ownerIds` lets a caller pin an explicit list.
export async function sourceDemand(
  deps: SourcingDeps,
  demand: DemandRequest,
  opts: { excludeOwnerIds?: string[]; ownerIds?: string[] } = {},
): Promise<{ sourced: boolean; reason?: string; loadId?: string; calledOwners?: number }> {
  const owners = await deps.ownersRepo.getActiveOwners();
  const plan = planSourcing(demand, owners);
  if (!plan.ok) return { sourced: false, reason: plan.reason };

  let loadId = demand.loadId;
  if (!loadId) {
    const load = await deps.loadsRepo.createLoad({ ...plan.load, createdBy: `demand:${demand.id}` });
    loadId = load.id;
    await deps.demandRepo.attachLoad(demand.id, loadId);
  } else {
    await deps.loadsRepo.setStatus(loadId, "CALLING");
  }

  let ownerIds = opts.ownerIds ?? plan.ownerIds;
  if (opts.excludeOwnerIds?.length) {
    const skip = new Set(opts.excludeOwnerIds);
    ownerIds = ownerIds.filter((id) => !skip.has(id));
  }

  await deps.demandRepo.setStatus(demand.id, "SOURCING");
  if (ownerIds.length) await deps.orchestrator.enqueue(loadId, ownerIds, "offer");
  return { sourced: true, loadId, calledOwners: ownerIds.length };
}
