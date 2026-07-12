import crypto from "node:crypto";
import { LrsRepo, Lr } from "./lrs.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { DemandRepo } from "../demand/demand.repo.js";
import { OwnersRepo } from "../owners/owners.repo.js";
import { WaSender, inr } from "../wa/wa-sender.js";

// No O, no I — visually ambiguous with 0 and 1 on a printed/photographed LR.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";

export function genLrNumber(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `PIN-${s}`;
}

export type MintDeps = {
  lrsRepo: LrsRepo;
  loadsRepo: LoadsRepo;
  demandRepo: DemandRepo;
  ownersRepo: OwnersRepo;
  waSender?: WaSender;
};

// Mints the system LR right after a load is BOOKED. Idempotent — a re-book
// attempt (or a second call site racing on the same load) just returns the
// existing LR instead of minting a duplicate. Side-B loads (dispatcher-posted,
// no demand row) still mint, just with ownerId left null and no notify. Never
// throws: an owner lookup miss or a WA send failure must not break booking.
export async function mintLr(deps: MintDeps, loadId: string): Promise<Lr | null> {
  try {
    const existing = await deps.lrsRepo.getByLoad(loadId);
    if (existing) return existing;

    const load = await deps.loadsRepo.getLoad(loadId);
    if (!load) return null;

    const demand = await deps.demandRepo.findByLoadId(loadId);
    const ownerId = demand?.winningOwnerId ?? null;

    let lr: Lr;
    try {
      lr = await deps.lrsRepo.create({ lrNumber: genLrNumber(), loadId, ownerId });
    } catch (e: any) {
      if (e?.code !== "23505") throw e; // not a unique-violation retry — a real failure
      lr = await deps.lrsRepo.create({ lrNumber: genLrNumber(), loadId, ownerId }); // one retry on collision
    }

    if (deps.waSender && ownerId) {
      try {
        const owners = await deps.ownersRepo.getActiveOwners();
        const owner = owners.find((o) => o.id === ownerId);
        if (owner && owner.channel !== "voice") {
          const agreed = demand?.lockedPriceInr ?? load.fixedPriceInr;
          await deps.waSender.sendText(
            owner.phone,
            `📄 Your LR: ${lr.lrNumber} — ${load.fromLocation} → ${load.toLocation} · ${inr(agreed)}. Send a photo of any LR or invoice here anytime.`,
          );
        }
      } catch {
        /* best-effort — a notify failure must never break booking */
      }
    }

    return lr;
  } catch {
    // ponytail: mint is best-effort — a failure must never break the booking that triggered it
    return null;
  }
}
