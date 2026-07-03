import { QuotesRepo } from "./quotes.repo.js";
import { CallsRepo } from "../calls/calls.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { DemandRepo } from "../demand/demand.repo.js";

export type AvailabilityDeps = {
  quotesRepo: QuotesRepo;
  callsRepo: CallsRepo;
  loadsRepo: LoadsRepo;
  demandRepo: DemandRepo;
};

export type AvailabilityResult = {
  ok: boolean;
  reason?: string;
  created?: boolean;
  locked?: boolean;
  loadId?: string;
  ownerId?: string;
};

// Shared: record an owner's availability outcome + run the domino (follow-up on
// counter, lock on accept). Used by the in-call report and the hangup callback,
// and (Task 8) the WhatsApp driver flow.
export async function recordAvailability(
  deps: AvailabilityDeps,
  f: {
    cid?: string | null;
    available?: string | null;
    acceptsFixed?: boolean | null;
    quotedPriceInr?: number | null;
    vehicleType?: string | null;
    note?: string | null;
    lockPriceInr?: number | null;
  },
): Promise<AvailabilityResult> {
  if (!f.cid) return { ok: false, reason: "no conversationId" };
  const call = await deps.callsRepo.findByConversationId(f.cid);
  if (!call) return { ok: false, reason: "unknown conversation" };

  const quotedPriceInr = f.quotedPriceInr ?? null;
  const availableProvided = f.available != null;
  const availUpper = (f.available ?? "YES").toUpperCase();
  const available = (["YES", "NO", "CALLBACK"].includes(availUpper) ? availUpper : "YES") as
    | "YES"
    | "NO"
    | "CALLBACK";
  let acceptsFixed = f.acceptsFixed ?? null;
  if (acceptsFixed === null) {
    if (quotedPriceInr != null) acceptsFixed = false;
    else if (availableProvided && available === "YES") acceptsFixed = true;
  }

  const { created } = await deps.quotesRepo.upsertByConversation({
    loadId: call.loadId,
    ownerId: call.ownerId,
    callAttemptId: call.id,
    elConversationId: f.cid,
    available,
    quotedPriceInr,
    acceptsFixed,
    vehicleType: f.vehicleType ?? null,
    note: f.note ?? null,
  });

  // NOTE: a counter (available YES, acceptsFixed false) is NOT auto-recalled.
  // The dispatcher decides on the board: "Accept ₹<counter>" or "Hold ₹<fixed>"
  // (the Hold button triggers a fixed_price_followup manually). Auto-recalling
  // was confusing — it called the driver twice with the same conversation.
  let locked = false;
  if (created && available === "YES" && acceptsFixed === true) {
    const load = await deps.loadsRepo.getLoad(call.loadId);
    const demand = await deps.demandRepo.findByLoadId(call.loadId);
    if (demand) {
      const lockedDriver = await deps.demandRepo.lockDriver(
        call.loadId,
        call.ownerId,
        f.lockPriceInr ?? load?.fixedPriceInr ?? quotedPriceInr ?? 0,
      );
      if (lockedDriver) {
        await deps.loadsRepo.setStatus(call.loadId, "LOCKED");
        await deps.callsRepo.supersedePending(call.loadId, call.ownerId);
        locked = true;
      }
    } else if (load && load.status === "CALLING") {
      await deps.loadsRepo.setStatus(call.loadId, "LOCKED");
      await deps.callsRepo.supersedePending(call.loadId, call.ownerId);
      locked = true;
    }
  }
  return { ok: true, created, locked, loadId: call.loadId, ownerId: call.ownerId };
}
