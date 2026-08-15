import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { fakeInterakt } from "./helpers/wa.js";
import { loadConfig } from "../src/config.js";
import { CampaignsRepo } from "../src/campaigns/campaigns.repo.js";
import { ContactsRepo } from "../src/campaigns/contacts.repo.js";
import { CampaignAttemptsRepo } from "../src/campaigns/campaign-attempts.repo.js";
import { CampaignEventsRepo } from "../src/campaigns/campaign-docs.repo.js";
import { WaSessionsRepo } from "../src/wa/wa-sessions.repo.js";
import { buildCampaignSender } from "../src/campaigns/campaign-sender.js";
import { fireLeg1, expireLeg1 } from "../src/campaigns/leg1.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!,
  API_KEY: "k",
  WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p",
  MAX_CONCURRENT: "2",
} as unknown as NodeJS.ProcessEnv);

async function setup(failSends = false) {
  const { pool } = await withTestDb();
  const { client, sent } = fakeInterakt(failSends);
  const campaigns = new CampaignsRepo(pool);
  const contacts = new ContactsRepo(pool);
  const attempts = new CampaignAttemptsRepo(pool);
  const events = new CampaignEventsRepo(pool);
  const sessions = new WaSessionsRepo(pool);
  const sender = buildCampaignSender({ interakt: client, attempts, sessions, config });
  const campaign = await campaigns.create({ code: "CMP-9", name: "Docs", createdBy: "ops" });
  const deps = { contacts, attempts, events, sender, config };
  return { pool, sent, campaigns, contacts, attempts, events, sessions, campaign, deps };
}

const add = (contacts: ContactsRepo, campaignId: string, name: string, digits: string) =>
  contacts.upsert({ campaignId, name, phoneDigits: digits });

describe("campaign leg 1", () => {
  it("sends to every uploaded contact and moves them to L1_SENT", async () => {
    const { sent, contacts, attempts, campaign, deps } = await setup();
    await add(contacts, campaign.id, "Sneha Patel", "919978640219");
    await add(contacts, campaign.id, "Ravi Kulkarni", "919820411872");

    expect(await fireLeg1(deps, campaign.id)).toEqual({ sent: 2, failed: 0 });

    const rows = await contacts.listByCampaign(campaign.id);
    expect(rows.map((r) => r.stage)).toEqual(["L1_SENT", "L1_SENT"]);
    expect(sent.filter((s) => s.kind === "buttons")).toHaveLength(2);

    // buttons carry the verb:uuid grammar the inbound ladder parses
    const ids = sent[0].args[1].map((b: any) => b.id.split(":")[0]);
    expect(ids).toEqual(["c1y", "c1n"]);

    const live = await attempts.findLive(rows[0].id, 1);
    expect(live).toMatchObject({ leg: 1, channel: "wa", status: "IN_PROGRESS" });
  });

  it("falls back to the approved template when the free session send is refused", async () => {
    const { pool } = await withTestDb();
    // buttons refused (outside the 24h window), template accepted — the cold-send path
    const sent: { kind: string; to: string; args: any[] }[] = [];
    const client = {
      sendButtons: async () => {
        throw new Error("outside session window");
      },
      sendTemplate: async (to: string, ...args: any[]) => {
        sent.push({ kind: "template", to, args });
        return [];
      },
      sendText: async () => [],
      sendList: async () => [],
    } as any;

    const campaigns = new CampaignsRepo(pool);
    const contacts = new ContactsRepo(pool);
    const attempts = new CampaignAttemptsRepo(pool);
    const events = new CampaignEventsRepo(pool);
    const sessions = new WaSessionsRepo(pool);
    const sender = buildCampaignSender({ interakt: client, attempts, sessions, config });
    const campaign = await campaigns.create({ code: "CMP-T", name: "Docs", createdBy: "ops" });
    await add(contacts, campaign.id, "Sneha Patel", "919978640219");

    expect(await fireLeg1({ contacts, attempts, events, sender, config }, campaign.id)).toEqual({
      sent: 1,
      failed: 0,
    });
    expect(sent[0]).toMatchObject({ kind: "template", to: "919978640219" });
    expect(sent[0].args[0]).toBe(config.campaignTemplate);
    expect(sent[0].args[1]).toEqual(["Sneha Patel"]); // one body variable: the name
    expect(Object.keys(sent[0].args[2])).toEqual(["0", "1"]); // button payloads by index

    // the session stores the STATIC template button titles, so Interakt's
    // title-only click echo still resolves back to our payload ids
    const session = await sessions.get("919978640219");
    expect(session).toMatchObject({ role: "campaign", state: "L1_OFFERED" });
    expect(session?.lastOptions.map((o) => o.title)).toEqual([
      "Yes, submit document",
      "Not interested",
    ]);
  });

  it("leaves a failed send at UPLOADED so it is never treated as a refusal", async () => {
    const { contacts, attempts, campaign, deps } = await setup(true);
    const contact = await add(contacts, campaign.id, "Sneha Patel", "919978640219");

    expect(await fireLeg1(deps, campaign.id)).toEqual({ sent: 0, failed: 1 });
    expect((await contacts.get(contact.id))?.stage).toBe("UPLOADED");
    const all = await attempts.listByContact(contact.id);
    expect(all[0].status).toBe("FAILED");
  });

  it("skips contacts that are not at UPLOADED (no double-send on re-fire)", async () => {
    const { sent, contacts, campaign, deps } = await setup();
    await add(contacts, campaign.id, "Sneha Patel", "919978640219");
    await fireLeg1(deps, campaign.id);
    expect(await fireLeg1(deps, campaign.id)).toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it("expires a silent contact to L1_NO_REPLY without escalating it to leg 2", async () => {
    const { pool, contacts, campaign, deps } = await setup();
    const contact = await add(contacts, campaign.id, "Meera Nair", "919745520088");
    await fireLeg1(deps, campaign.id);
    await pool.query(`UPDATE campaign_attempts SET created_at = now() - interval '2 days'`);

    expect(await expireLeg1(deps, campaign.id)).toBe(1);
    expect((await contacts.get(contact.id))?.stage).toBe("L1_NO_REPLY");
  });
});
