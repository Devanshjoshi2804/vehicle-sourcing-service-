import { AvailabilityDeps, recordAvailability } from "../quotes/availability.js";
import { CallsRepo } from "./calls.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { DemandRepo } from "../demand/demand.repo.js";

// Shared cores behind the WA driver/customer flows AND the email channel
// (Task 8+): the accept/counter/decline of a call attempt, and the book/decline
// of a customer's booking confirmation. Lifted verbatim out of src/wa/driver-flow.ts
// and src/wa/customer-flow.ts — callers keep their own session-clear + reply text.
export type ActionDeps = {
  availability: AvailabilityDeps;
  callsRepo: CallsRepo;
  loadsRepo: LoadsRepo;
  demandRepo: DemandRepo;
};

export type AcceptOutcome = { kind: "locked" | "already_yours" | "filled"; priceInr: number | null };

// recordAvailability matches a call via el_conversation_id — that's `wa_<id>` for
// a WA offer but `em_<id>` for an email one (email-sender.ts sets it). Look up
// the attempt's REAL conversation id instead of assuming the WA prefix, so email
// accept/counter/decline actually find their call_attempts row.
async function cidFor(deps: ActionDeps, attemptId: string): Promise<string> {
  const attempt = await deps.callsRepo.getById(attemptId);
  return attempt?.elConversationId ?? `wa_${attemptId}`;
}

export async function acceptAttempt(
  deps: ActionDeps,
  attemptId: string,
  priceInr: number | null,
): Promise<AcceptOutcome> {
  // allowUpdate: a driver who countered first can still accept — the stored
  // quote upgrades to accepts_fixed and the (idempotent) lock runs.
  const r = await recordAvailability(deps.availability, {
    cid: await cidFor(deps, attemptId), available: "YES", acceptsFixed: true, lockPriceInr: priceInr, allowUpdate: true,
  });
  await deps.callsRepo.setStatus(attemptId, "DONE", { ended: true });
  if (r.ok && r.locked) {
    return { kind: "locked", priceInr };
  }
  // Not locked by THIS call — but the lock may already be theirs (dispatcher
  // accepted them on the console, or a double-tap). Never tell the winner
  // someone else got it.
  if (r.ok && r.loadId) {
    const demand = await deps.demandRepo.findByLoadId(r.loadId);
    if (demand?.winningOwnerId && demand.winningOwnerId === r.ownerId) {
      return { kind: "already_yours", priceInr: demand.lockedPriceInr };
    }
  }
  return { kind: "filled", priceInr: null };
}

export async function counterAttempt(
  deps: ActionDeps,
  attemptId: string,
  priceInr: number,
): Promise<{ ok: boolean }> {
  const r = await recordAvailability(deps.availability, {
    cid: await cidFor(deps, attemptId), available: "YES", acceptsFixed: false, quotedPriceInr: priceInr, allowUpdate: true,
  });
  await deps.callsRepo.setStatus(attemptId, "DONE", { ended: true });
  return { ok: r.ok };
}

export async function declineAttempt(deps: ActionDeps, attemptId: string): Promise<void> {
  await recordAvailability(deps.availability, { cid: await cidFor(deps, attemptId), available: "NO", allowUpdate: true });
  await deps.callsRepo.setStatus(attemptId, "DONE", { ended: true });
}

export async function bookDemand(deps: ActionDeps, demandId: string): Promise<"booked" | "not_pending"> {
  const booked = await deps.demandRepo.book(demandId);
  if (!booked) return "not_pending";
  if (booked.loadId) await deps.loadsRepo.setStatus(booked.loadId, "BOOKED");
  return "booked";
}

export async function declineBooking(deps: ActionDeps, demandId: string): Promise<"declined" | "not_pending"> {
  const d = await deps.demandRepo.declinePending(demandId);
  if (!d) return "not_pending";
  if (d.loadId) await deps.loadsRepo.setStatus(d.loadId, "CLOSED");
  return "declined";
}
