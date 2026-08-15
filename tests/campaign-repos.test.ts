import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { runMigrations } from "../src/db/migrate.js";
import { CampaignsRepo } from "../src/campaigns/campaigns.repo.js";
import { ContactsRepo } from "../src/campaigns/contacts.repo.js";
import { CampaignAttemptsRepo } from "../src/campaigns/campaign-attempts.repo.js";
import { CampaignDocsRepo, CampaignEventsRepo } from "../src/campaigns/campaign-docs.repo.js";

async function setup() {
  const { pool } = await withTestDb();
  return {
    pool,
    campaigns: new CampaignsRepo(pool),
    contacts: new ContactsRepo(pool),
    attempts: new CampaignAttemptsRepo(pool),
    docs: new CampaignDocsRepo(pool),
    events: new CampaignEventsRepo(pool),
  };
}

describe("campaign repos", () => {
  it("re-applies migration 007 without error (the runner replays every file on boot)", async () => {
    const { pool } = await setup();
    await runMigrations(pool);
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name LIKE 'campaign%'`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      "campaign_attempts",
      "campaign_contacts",
      "campaign_docs",
      "campaign_events",
      "campaigns",
    ]);
  });

  it("keeps one record per number per campaign — a re-upload updates, never duplicates", async () => {
    const { campaigns, contacts } = await setup();
    const c = await campaigns.create({ code: "CMP-1", name: "Doc drive", createdBy: "ops" });
    const first = await contacts.upsert({
      campaignId: c.id,
      name: "Sneha Patel",
      phoneDigits: "919978640219",
      city: "Surat",
    });
    const again = await contacts.upsert({
      campaignId: c.id,
      name: "Sneha P",
      phoneDigits: "919978640219",
      city: "Surat",
    });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("Sneha P");
    expect(await contacts.listByCampaign(c.id)).toHaveLength(1);
  });

  it("resolves an inbound sender only while a leg-1 attempt is live", async () => {
    const { campaigns, contacts, attempts } = await setup();
    const c = await campaigns.create({ code: "CMP-2", name: "Drive", createdBy: "ops" });
    const contact = await contacts.upsert({
      campaignId: c.id,
      name: "Ravi",
      phoneDigits: "919820411872",
    });

    // no attempt yet → a stray inbound must not attach to this campaign
    expect(await contacts.findLiveByPhone("919820411872")).toBeNull();

    const a = await attempts.create({ contactId: contact.id, leg: 1, channel: "wa" });
    expect((await contacts.findLiveByPhone("919820411872"))?.id).toBe(contact.id);

    // once the leg is finished the number stops resolving
    await attempts.setStatus(a.id, "DONE", { ended: true });
    expect(await contacts.findLiveByPhone("919820411872")).toBeNull();
  });

  it("records an IVR digit and counts attempts per leg", async () => {
    const { campaigns, contacts, attempts } = await setup();
    const c = await campaigns.create({ code: "CMP-3", name: "Drive", createdBy: "ops" });
    const contact = await contacts.upsert({
      campaignId: c.id,
      name: "Imran",
      phoneDigits: "919833077641",
    });
    const a = await attempts.create({ contactId: contact.id, leg: 2, channel: "ivr" });
    await attempts.recordDigit(a.id, "1", 52);

    const fresh = await attempts.getById(a.id);
    expect(fresh).toMatchObject({ digit: "1", durationS: 52, status: "DONE" });
    expect(fresh?.endedAt).not.toBeNull();
    expect(await attempts.countByContactLeg(contact.id, 2)).toBe(1);
  });

  it("closes stale IVR attempts but leaves WhatsApp offers alone", async () => {
    const { pool, campaigns, contacts, attempts } = await setup();
    const c = await campaigns.create({ code: "CMP-4", name: "Drive", createdBy: "ops" });
    const contact = await contacts.upsert({
      campaignId: c.id,
      name: "Meera",
      phoneDigits: "919745520088",
    });
    const ivr = await attempts.create({ contactId: contact.id, leg: 2, channel: "ivr" });
    const wa = await attempts.create({ contactId: contact.id, leg: 1, channel: "wa" });
    await pool.query(`UPDATE campaign_attempts SET created_at = now() - interval '30 minutes'`);

    expect(await attempts.closeStale(10, "ivr")).toBe(1);
    expect((await attempts.getById(ivr.id))?.status).toBe("NO_ANSWER");
    expect((await attempts.getById(wa.id))?.status).toBe("QUEUED");
  });

  it("stores docs and a timeline per contact", async () => {
    const { campaigns, contacts, docs, events } = await setup();
    const c = await campaigns.create({ code: "CMP-5", name: "Drive", createdBy: "ops" });
    const contact = await contacts.upsert({
      campaignId: c.id,
      name: "Fatima",
      phoneDigits: "919004591123",
    });
    const d = await docs.create({
      contactId: contact.id,
      source: "wa",
      mediaUrl: "https://bsp.example/doc.jpg",
      extracted: { kind: "aadhaar" },
    });
    await docs.setStatus(d.id, "verified");
    await events.log(contact.id, "wa_reply", { leg: 1, detail: { digit: "1" } });

    expect(await docs.countByCampaign(c.id)).toEqual({ received: 1, verified: 1 });
    expect((await events.listByContact(contact.id)).map((e) => e.kind)).toEqual(["wa_reply"]);
  });
});
