import pg from "pg";
import { Config } from "../config.js";
import { ContactsRepo } from "./contacts.repo.js";
import { CampaignAttemptsRepo } from "./campaign-attempts.repo.js";
import { CampaignEventsRepo } from "./campaign-docs.repo.js";
import { IvrDialer } from "./ivr.client.js";

export type Leg2Deps = {
  pool: pg.Pool;
  contacts: ContactsRepo;
  attempts: CampaignAttemptsRepo;
  events: CampaignEventsRepo;
  dialer: IvrDialer;
  config: Config;
};

// "IVR input must equal the eligible output from WhatsApp" (BRD rule 2). This is
// one set-based UPDATE over exactly the leg-1 refusals, so the two populations
// cannot drift: nothing else can enter L2_QUEUED.
export async function enrolLeg2(deps: Leg2Deps, campaignId: string): Promise<{ queued: number }> {
  const { rowCount } = await deps.pool.query(
    `UPDATE campaign_contacts
        SET stage='L2_QUEUED', updated_at=now()
      WHERE campaign_id=$1 AND stage='L1_DECLINED'`,
    [campaignId],
  );
  return { queued: rowCount ?? 0 };
}

// Dial everyone sitting in the leg-2 queue, capped at MAX_CONCURRENT to respect
// the trunk's outbound CPS (the same cap the sourcing orchestrator uses).
export async function dialLeg2(
  deps: Leg2Deps,
  campaignId: string,
): Promise<{ dialed: number; failed: number }> {
  const queue = await deps.contacts.listByCampaign(campaignId, ["L2_QUEUED"]);
  let dialed = 0;
  let failed = 0;

  const limit = Math.max(1, deps.config.maxConcurrent);
  let idx = 0;
  const worker = async () => {
    while (idx < queue.length) {
      const contact = queue[idx++];
      // Skip anyone already on a live call, so a double-click can't double-dial.
      if (await deps.attempts.findLive(contact.id, 2)) continue;
      const attemptNo = (await deps.attempts.countByContactLeg(contact.id, 2)) + 1;
      if (attemptNo > deps.config.campaignIvrAttempts) {
        await escalate(deps, contact.id, "attempts exhausted");
        continue;
      }
      const attempt = await deps.attempts.create({
        contactId: contact.id,
        leg: 2,
        channel: "ivr",
        attemptNo,
      });
      try {
        const { callRef } = await deps.dialer.dial(attempt.id, contact.phoneDigits);
        await deps.attempts.setProviderRef(attempt.id, callRef);
        await deps.attempts.setStatus(attempt.id, "DIALING");
        await deps.events.log(contact.id, "ivr_dialed", { leg: 2, detail: { attemptNo } });
        dialed++;
      } catch (err) {
        await deps.attempts.setStatus(attempt.id, "FAILED", { ended: true });
        await deps.events.log(contact.id, "ivr_dial_failed", {
          leg: 2,
          detail: { error: String((err as Error)?.message ?? err) },
        });
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  return { dialed, failed };
}

// The keypad answer decides whether automation keeps the number or a human gets it.
export async function recordDigit(
  deps: Leg2Deps,
  attemptId: string,
  digit: string | null,
  durationS?: number | null,
): Promise<{ ok: boolean; stage?: string }> {
  const attempt = await deps.attempts.getById(attemptId);
  if (!attempt || attempt.leg !== 2) return { ok: false };
  // Terminal already (a retried webhook, or the hangup callback beat us here).
  if (attempt.digit) return { ok: true, stage: undefined };

  await deps.attempts.recordDigit(attemptId, digit, durationS);

  if (digit === "1") {
    await deps.contacts.setStage(attempt.contactId, "L2_INTERESTED");
    await deps.events.log(attempt.contactId, "ivr_key", { leg: 2, detail: { digit } });
    return { ok: true, stage: "L2_INTERESTED" };
  }
  if (digit === "2") {
    await deps.contacts.setStage(attempt.contactId, "L2_DECLINED");
    await deps.events.log(attempt.contactId, "ivr_key", { leg: 2, detail: { digit } });
    // Refused on both automated legs — this is what a human finally calls.
    await escalate(deps, attempt.contactId, "declined on both legs");
    return { ok: true, stage: "L3_QUEUED" };
  }

  // No key: one more dial is allowed, otherwise a human takes it.
  const used = await deps.attempts.countByContactLeg(attempt.contactId, 2);
  if (used >= deps.config.campaignIvrAttempts) {
    await deps.contacts.setStage(attempt.contactId, "L2_NO_KEY");
    await deps.events.log(attempt.contactId, "ivr_no_key", { leg: 2, detail: { used } });
    await escalate(deps, attempt.contactId, "no key after retries");
    return { ok: true, stage: "L3_QUEUED" };
  }
  await deps.contacts.setStage(attempt.contactId, "L2_QUEUED"); // retry on the next dial pass
  await deps.events.log(attempt.contactId, "ivr_retry_scheduled", { leg: 2, detail: { used } });
  return { ok: true, stage: "L2_QUEUED" };
}

async function escalate(deps: Leg2Deps, contactId: string, reason: string) {
  await deps.contacts.setStage(contactId, "L3_QUEUED");
  await deps.events.log(contactId, "escalated_to_manual", { leg: 3, detail: { reason } });
}
