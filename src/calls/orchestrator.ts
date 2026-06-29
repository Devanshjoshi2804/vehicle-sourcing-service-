import pg from "pg";
import { Config } from "../config.js";
import { ElevenLabsClient } from "./elevenlabs.client.js";
import { OwnersRepo } from "../owners/owners.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { CallsRepo, CallAttempt, CallFlow } from "./calls.repo.js";
import { Load } from "../loads/loads.schema.js";
import { Owner } from "../owners/owners.schema.js";
import { buildDynamicVars } from "./dynamic-vars.js";

type Deps = {
  pool: pg.Pool;
  config: Config;
  el: ElevenLabsClient;
  ownersRepo: OwnersRepo;
  loadsRepo: LoadsRepo;
  callsRepo: CallsRepo;
};

export class CallOrchestrator {
  constructor(private d: Deps) {}

  async enqueue(
    loadId: string,
    ownerIds: string[],
    flow: CallFlow = "offer",
  ): Promise<{ queued: number }> {
    const load = await this.d.loadsRepo.getLoad(loadId);
    if (!load) throw new Error("load not found");
    const owners = await this.d.ownersRepo.getActiveOwners();
    const byId = new Map(owners.map((o) => [o.id, o]));

    const attempts: CallAttempt[] = [];
    for (const ownerId of ownerIds) {
      const owner = byId.get(ownerId);
      if (!owner) continue;
      const attempt = await this.d.callsRepo.create({
        loadId,
        ownerId,
        phone: owner.phone,
        flow,
      });
      attempts.push(attempt);
    }
    await this.d.loadsRepo.setStatus(loadId, "CALLING");

    await this.drain(attempts, load, byId, flow);
    return { queued: attempts.length };
  }

  private async drain(
    attempts: CallAttempt[],
    load: Load,
    byId: Map<string, Owner>,
    flow: CallFlow,
  ) {
    const limit = this.d.config.maxConcurrent;
    let idx = 0;
    const worker = async () => {
      while (idx < attempts.length) {
        const a = attempts[idx++];
        const owner = byId.get(a.ownerId);
        if (owner) await this.placeOne(a, load, owner, flow);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, attempts.length) }, worker));
  }

  private async placeOne(a: CallAttempt, load: Load, owner: Owner, flow: CallFlow) {
    const vars = buildDynamicVars(load, owner, flow, this.d.config.companyName);
    for (let attempt = 1; attempt <= this.d.config.maxAttempts; attempt++) {
      try {
        await this.d.callsRepo.setStatus(a.id, "DIALING");
        const { conversationId } = await this.d.el.originateCall({
          toNumber: a.phone,
          dynamicVariables: vars,
        });
        await this.d.callsRepo.setConversationId(a.id, conversationId);
        await this.d.callsRepo.setStatus(a.id, "IN_PROGRESS");
        return;
      } catch {
        if (attempt >= this.d.config.maxAttempts) {
          await this.d.callsRepo.setStatus(a.id, "FAILED", { ended: true });
        }
      }
    }
  }
}
