import { Config } from "../config.js";
import { Contact } from "./campaigns.repo.js";
import { ContactsRepo } from "./contacts.repo.js";
import { CampaignAttemptsRepo } from "./campaign-attempts.repo.js";
import { CampaignEventsRepo } from "./campaign-docs.repo.js";
import { CampaignSender } from "./campaign-sender.js";

export type Leg1Deps = {
  contacts: ContactsRepo;
  attempts: CampaignAttemptsRepo;
  events: CampaignEventsRepo;
  sender: CampaignSender;
  config: Config;
};

// Fire the WhatsApp leg at every contact still sitting at UPLOADED. Concurrency
// is capped by MAX_CONCURRENT — the same worker-pool shape the call orchestrator
// uses, because the BSP rate-limits the same way the trunk does.
export async function fireLeg1(
  deps: Leg1Deps,
  campaignId: string,
): Promise<{ sent: number; failed: number }> {
  const eligible = await deps.contacts.listByCampaign(campaignId, ["UPLOADED"]);
  let sent = 0;
  let failed = 0;

  const limit = Math.max(1, deps.config.maxConcurrent);
  let idx = 0;
  const worker = async () => {
    while (idx < eligible.length) {
      const contact = eligible[idx++];
      const ok = await sendOne(deps, contact);
      if (ok) sent++;
      else failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, eligible.length) }, worker));
  return { sent, failed };
}

async function sendOne(deps: Leg1Deps, contact: Contact): Promise<boolean> {
  const attempt = await deps.attempts.create({ contactId: contact.id, leg: 1, channel: "wa" });
  try {
    await deps.sender.sendLeg1(attempt, contact);
    await deps.contacts.setStage(contact.id, "L1_SENT");
    await deps.events.log(contact.id, "wa_sent", { leg: 1, detail: { attemptId: attempt.id } });
    return true;
  } catch (err) {
    // A send that fails outright (bad number, template rejected, BSP down) ends
    // the attempt as FAILED and leaves the contact at UPLOADED so a later re-fire
    // picks it up — it must NOT silently fall through to leg 2, which is defined
    // as "the people who answered 2".
    await deps.attempts.setStatus(attempt.id, "FAILED", { ended: true });
    await deps.events.log(contact.id, "wa_send_failed", {
      leg: 1,
      detail: { error: String((err as Error)?.message ?? err) },
    });
    return false;
  }
}

// A contact who never replied inside the template window. The prototype keeps
// them in leg 1 rather than escalating, so this only closes the attempt.
export async function expireLeg1(deps: Leg1Deps, campaignId: string): Promise<number> {
  const waiting = await deps.contacts.listByCampaign(campaignId, ["L1_SENT"]);
  let expired = 0;
  for (const c of waiting) {
    const live = await deps.attempts.findLive(c.id, 1);
    if (!live) continue;
    const ageMin = (Date.now() - new Date(live.createdAt).getTime()) / 60000;
    if (ageMin < deps.config.campaignL1WindowMin) continue;
    await deps.attempts.setStatus(live.id, "NO_ANSWER", { ended: true });
    await deps.contacts.setStage(c.id, "L1_NO_REPLY");
    await deps.events.log(c.id, "wa_no_reply", { leg: 1 });
    expired++;
  }
  return expired;
}
