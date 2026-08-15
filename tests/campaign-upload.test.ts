import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { signAction } from "../src/email/tokens.js";

const dir = await mkdtemp(join(tmpdir(), "vss-uploads-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!,
  API_KEY: "k",
  WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p",
  UPLOAD_DIR: dir,
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function setup(vision?: any) {
  const { pool } = await withTestDb();
  const app = buildServer({ pool, config, vision });
  const campaign = (
    await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: auth,
      payload: { name: "Docs", createdBy: "ops" },
    })
  ).json();
  await app.inject({
    method: "POST",
    url: `/campaigns/${campaign.id}/contacts`,
    headers: { ...auth, "content-type": "text/csv" },
    payload: "name,phone\nSneha Patel,9978640219",
  });
  const contact = (
    await app.inject({ method: "GET", url: `/campaigns/${campaign.id}/contacts`, headers: auth })
  ).json()[0];
  const token = signAction("w", { a: "cup", id: contact.id });
  return { app, campaign, contact, token };
}

describe("campaign document upload link", () => {
  it("serves an upload page for a valid token", async () => {
    const { app, token } = await setup();
    const res = await app.inject({ method: "GET", url: `/c/u/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Sneha Patel");
  });

  it("refuses a tampered or expired token", async () => {
    const { app, contact } = await setup();
    expect((await app.inject({ method: "GET", url: `/c/u/notatoken` })).statusCode).toBe(410);

    const expired = signAction("w", { a: "cup", id: contact.id, x: Math.floor(Date.now() / 1000) - 10 });
    expect((await app.inject({ method: "GET", url: `/c/u/${expired}` })).statusCode).toBe(410);

    // signed with the wrong secret
    const forged = signAction("not-the-secret", { a: "cup", id: contact.id });
    expect((await app.inject({ method: "POST", url: `/c/u/${forged}`, payload: png, headers: { "content-type": "image/png" } })).statusCode).toBe(410);
  });

  it("stores the bytes, records the doc and advances the contact", async () => {
    const { app, campaign, contact, token } = await setup();
    const res = await app.inject({
      method: "POST",
      url: `/c/u/${token}`,
      payload: png,
      headers: { "content-type": "image/png" },
    });
    expect(res.statusCode).toBe(200);

    const files = (await readdir(dir)).filter((f) => f.startsWith(contact.id));
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(".png")).toBe(true);

    const contacts = (
      await app.inject({ method: "GET", url: `/campaigns/${campaign.id}/contacts`, headers: auth })
    ).json();
    expect(contacts[0].stage).toBe("DOC_RECEIVED");
  });

  it("reads the stored file back for the console", async () => {
    const { app, contact, token } = await setup();
    await app.inject({ method: "POST", url: `/c/u/${token}`, payload: png, headers: { "content-type": "image/png" } });

    const timeline = (
      await app.inject({ method: "GET", url: `/campaigns/contacts/${contact.id}/timeline`, headers: auth })
    ).json();
    expect(timeline.events.map((e: any) => e.kind)).toContain("doc_received");
  });

  it("rejects an empty body", async () => {
    const { app, token } = await setup();
    const res = await app.inject({
      method: "POST",
      url: `/c/u/${token}`,
      payload: Buffer.alloc(0),
      headers: { "content-type": "image/png" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("still stores the file when vision cannot read it", async () => {
    const { app, token } = await setup({
      extract: async () => ({ ok: false, reason: "no_provider" }),
      extractFromBuffer: async () => ({ ok: false, reason: "no_provider" }),
    });
    const res = await app.inject({ method: "POST", url: `/c/u/${token}`, payload: png, headers: { "content-type": "image/png" } });
    expect(res.statusCode).toBe(200);
  });
});
