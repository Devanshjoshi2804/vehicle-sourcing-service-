import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { fakeInterakt } from "./helpers/wa.js";
import { loadConfig } from "../src/config.js";
import { CampaignsRepo } from "../src/campaigns/campaigns.repo.js";
import { ContactsRepo } from "../src/campaigns/contacts.repo.js";
import { CampaignAttemptsRepo } from "../src/campaigns/campaign-attempts.repo.js";
import { CampaignDocsRepo, CampaignEventsRepo } from "../src/campaigns/campaign-docs.repo.js";
import { WaSessionsRepo } from "../src/wa/wa-sessions.repo.js";
import { buildCampaignSender } from "../src/campaigns/campaign-sender.js";
import { fireLeg1 } from "../src/campaigns/leg1.js";
import { handleCampaignMessage, readChoice } from "../src/campaigns/campaign-flow.js";
import { WaInbound } from "../src/wa/inbound.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!,
  API_KEY: "k",
  WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p",
} as NodeJS.ProcessEnv);

const PHONE = "919978640219";

async function setup(vision?: any) {
  const { pool } = await withTestDb();
  const { client, sent } = fakeInterakt();
  const campaigns = new CampaignsRepo(pool);
  const contacts = new ContactsRepo(pool);
  const attempts = new CampaignAttemptsRepo(pool);
  const docs = new CampaignDocsRepo(pool);
  const events = new CampaignEventsRepo(pool);
  const sessions = new WaSessionsRepo(pool);
  const sender = buildCampaignSender({ interakt: client, attempts, sessions, config });
  const campaign = await campaigns.create({ code: "CMP-IN", name: "Docs", createdBy: "ops" });
  await contacts.upsert({ campaignId: campaign.id, name: "Sneha Patel", phoneDigits: PHONE });
  await fireLeg1({ contacts, attempts, events, sender, config }, campaign.id);
  const contact = (await contacts.listByCampaign(campaign.id))[0];
  const flow = { contacts, attempts, docs, events, sender, config, vision };
  return { pool, sent, contacts, attempts, docs, events, contact, flow };
}

const msg = (over: Partial<WaInbound>): WaInbound => ({
  from: PHONE,
  msgId: "m" + Math.random(),
  contactName: "Sneha",
  kind: "text",
  ...over,
});

describe("campaign inbound", () => {
  it("reads 1/2 from a payload id, a button title, or free text", () => {
    expect(readChoice(msg({ kind: "reply", replyId: "c1y:abc" }))).toBe("yes");
    expect(readChoice(msg({ kind: "reply", replyId: "c1n:abc" }))).toBe("no");
    expect(readChoice(msg({ text: "1" }))).toBe("yes");
    expect(readChoice(msg({ text: "2" }))).toBe("no");
    expect(readChoice(msg({ text: "yes please" }))).toBe("yes");
    expect(readChoice(msg({ replyTitle: "Not interested" }))).toBe("no");
    expect(readChoice(msg({ text: "what is this about" }))).toBeNull();
  });

  it("'1' marks interested, closes the attempt and asks for the document", async () => {
    const { sent, contacts, attempts, contact, flow } = await setup();
    await handleCampaignMessage(flow, msg({ kind: "reply", replyId: `c1y:x` }), contact);

    expect((await contacts.get(contact.id))?.stage).toBe("L1_INTERESTED");
    expect(await attempts.findLive(contact.id, 1)).toBeNull();
    expect(sent.some((s) => s.kind === "text" && /photo of your document/i.test(s.args[0]))).toBe(true);
  });

  it("'2' marks declined — the exact set leg 2 will dial", async () => {
    const { sent, contacts, contact, flow } = await setup();
    await handleCampaignMessage(flow, msg({ text: "2" }), contact);

    expect((await contacts.get(contact.id))?.stage).toBe("L1_DECLINED");
    expect(sent.some((s) => s.kind === "text" && /change your mind/i.test(s.args[0]))).toBe(true);
  });

  it("stores a photo and moves to DOC_RECEIVED, even when vision cannot read it", async () => {
    const failing = { extract: async () => ({ ok: false, reason: "extract_failed" }) };
    const { contacts, docs, contact, flow } = await setup(failing);
    await handleCampaignMessage(flow, msg({ kind: "media", mediaUrl: "https://bsp/doc.jpg" }), contact);

    expect((await contacts.get(contact.id))?.stage).toBe("DOC_RECEIVED");
    const stored = await docs.listByContact(contact.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ source: "wa", mediaUrl: "https://bsp/doc.jpg", status: "received" });
    expect(stored[0].extracted).toMatchObject({ ok: false, reason: "extract_failed" });
  });

  it("re-states the options when the reply is unintelligible", async () => {
    const { sent, contacts, contact, flow } = await setup();
    await handleCampaignMessage(flow, msg({ text: "who is this" }), contact);

    expect((await contacts.get(contact.id))?.stage).toBe("L1_SENT"); // unchanged
    expect(sent.some((s) => s.kind === "text" && /Reply 1 to send your document/i.test(s.args[0]))).toBe(true);
  });
});
