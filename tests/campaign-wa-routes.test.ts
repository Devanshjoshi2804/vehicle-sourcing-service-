import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fakeInterakt } from "./helpers/wa.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!,
  API_KEY: "k",
  WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p",
  INTERAKT_API_KEY: "ik",
  INTERAKT_WEBHOOK_SECRET: "sekrit",
  MAX_CONCURRENT: "2",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };
const csv = { ...auth, "content-type": "text/csv" };
const PHONE = "+919978640219";

const inbound = (text: string, phone = PHONE) => ({
  type: "message_received",
  data: {
    customer: { channel_phone_number: phone, traits: { name: "Sneha" } },
    message: { id: `m_${text}_${Math.random()}`, message_content_type: "Text", message: text },
  },
});
const sign = (body: string) => "sha256=" + crypto.createHmac("sha256", "sekrit").update(body).digest("hex");
const post = (app: any, payload: any) => {
  const body = JSON.stringify(payload);
  return app.inject({
    method: "POST",
    url: "/wa/inbound",
    payload: body,
    headers: { "content-type": "application/json", "interakt-signature": sign(body) },
  });
};

async function campaignApp(fire = true) {
  const { pool } = await withTestDb();
  const { client, sent } = fakeInterakt();
  const app = buildServer({
    pool,
    config,
    interakt: client,
    el: { originateCall: async () => ({ conversationId: "c" }) } as any,
  });
  const id = (
    await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: auth,
      payload: { name: "Docs", createdBy: "ops" },
    })
  ).json().id;
  await app.inject({
    method: "POST",
    url: `/campaigns/${id}/contacts`,
    headers: csv,
    payload: "name,phone\nSneha Patel,9978640219",
  });
  if (fire) await app.inject({ method: "POST", url: `/campaigns/${id}/fire-leg1`, headers: auth });
  const roleOf = async () => {
    const { rows } = await pool.query(`SELECT role FROM wa_sessions WHERE phone=$1`, ["919978640219"]);
    return rows[0]?.role ?? null;
  };
  return { app, sent, id, pool, roleOf };
}

const contactsOf = async (app: any, id: string) =>
  (await app.inject({ method: "GET", url: `/campaigns/${id}/contacts`, headers: auth })).json();

describe("campaign contact on the shared WhatsApp number", () => {
  it("routes '2' to the campaign flow, not to freight intake", async () => {
    const { app, id } = await campaignApp();
    const res = await post(app, inbound("2"));
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 400));

    expect((await contactsOf(app, id))[0].stage).toBe("L1_DECLINED");
    // the freight-demand side must not have picked this up
    const demand = await app.inject({ method: "GET", url: "/demand", headers: auth });
    expect(demand.json()).toHaveLength(0);
  });

  it("routes '1' to the campaign flow and asks for the document", async () => {
    const { app, sent, id } = await campaignApp();
    await post(app, inbound("1"));
    await new Promise((r) => setTimeout(r, 400));

    expect((await contactsOf(app, id))[0].stage).toBe("L1_INTERESTED");
    expect(sent.some((s) => s.kind === "text" && /photo of your document/i.test(s.args[0]))).toBe(true);
  });

  it("marks the session role campaign so the driver/customer split is bypassed", async () => {
    const { app, roleOf } = await campaignApp();
    await post(app, inbound("1"));
    await new Promise((r) => setTimeout(r, 400));
    expect(await roleOf()).toBe("campaign");
  });

  it("hands the number back to freight intake once the campaign attempt is closed", async () => {
    const { app, id, roleOf } = await campaignApp();
    await post(app, inbound("2"));
    await new Promise((r) => setTimeout(r, 400));
    expect((await contactsOf(app, id))[0].stage).toBe("L1_DECLINED");
    expect(await roleOf()).toBe("campaign");

    // no live campaign attempt now — a later message is an ordinary customer again
    await post(app, inbound("I need a truck from Mumbai to Pune"));
    await new Promise((r) => setTimeout(r, 500));
    expect(await roleOf()).toBe("customer");
    expect((await contactsOf(app, id))[0].stage).toBe("L1_DECLINED"); // campaign record untouched
  });

  it("does not touch contacts whose leg 1 was never fired", async () => {
    const { app, id } = await campaignApp(false);
    await post(app, inbound("1"));
    await new Promise((r) => setTimeout(r, 400));
    expect((await contactsOf(app, id))[0].stage).toBe("UPLOADED");
  });
});
