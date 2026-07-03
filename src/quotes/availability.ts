import { QuotesRepo } from "./quotes.repo.js";
import { CallsRepo } from "../calls/calls.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { DemandRepo } from "../demand/demand.repo.js";

export type AvailabilityDeps = {
  quotesRepo: QuotesRepo;
  callsRepo: CallsRepo;
  loadsRepo: LoadsRepo;
  demandRepo: DemandRepo;
  orchestrator?: { notifyFilled(loadId: string, exceptOwnerId: string): Promise<void> };
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
    // Explicit user action on an existing conversation (a driver who countered
    // then taps Accept): upgrade the stored quote instead of ignoring the repeat.
    allowUpdate?: boolean;
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

  const quote = {
    loadId: call.loadId,
    ownerId: call.ownerId,
    callAttemptId: call.id,
    elConversationId: f.cid,
    available,
    quotedPriceInr,
    acceptsFixed,
    vehicleType: f.vehicleType ?? null,
    note: f.note ?? null,
  };
  const { created } = await deps.quotesRepo.upsertByConversation(quote);
  // The lock ops below are individually race-safe (conditional UPDATEs), so an
  // allowUpdate re-answer can run them again without double-locking.
  const effective = created || (!created && f.allowUpdate === true && (await deps.quotesRepo.updateByConversation(quote)));

  // NOTE: a counter (available YES, acceptsFixed false) is NOT auto-recalled.
  // The dispatcher decides on the board: "Accept ₹<counter>" or "Hold ₹<fixed>"
  // (the Hold button triggers a fixed_price_followup manually). Auto-recalling
  // was confusing — it called the driver twice with the same conversation.
  let locked = false;
  if (effective && available === "YES" && acceptsFixed === true) {
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
        try {
          await deps.orchestrator?.notifyFilled(call.loadId, call.ownerId);
        } catch { /* best-effort — a notify failure must not abort the lock */ }
        await deps.callsRepo.supersedePending(call.loadId, call.ownerId);
        locked = true;
      }
    } else if (load && load.status === "CALLING") {
      await deps.loadsRepo.setStatus(call.loadId, "LOCKED");
      try {
        await deps.orchestrator?.notifyFilled(call.loadId, call.ownerId);
      } catch { /* best-effort — a notify failure must not abort the lock */ }
      await deps.callsRepo.supersedePending(call.loadId, call.ownerId);
      locked = true;
    }
  }
  return { ok: true, created, locked, loadId: call.loadId, ownerId: call.ownerId };
}
