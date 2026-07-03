import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fakeInterakt } from "./helpers/wa.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", INTERAKT_API_KEY: "ik", INTERAKT_WEBHOOK_SECRET: "sekrit",
  MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1", GOOGLE_MAPS_API_KEY: "",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };
const fakeGeo = { async resolveLocation(text: string) {
  return { raw: text, canonical: text, city: text, state: "MH", lat: 19.1, lng: 72.8, source: "test" };
} };
const sign = (b: string) => "sha256=" + crypto.createHmac("sha256", "sekrit").update(b).digest("hex");
const waMsg = (app: any, phone: string, message: any, id: string) => {
  const body = JSON.stringify({ type: "message_received",
    data: { customer: { channel_phone_number: phone, traits: { name: "X" } },
            message: { id, message_content_type: "Text", message } } });
  return app.inject({ method: "POST", url: "/wa/inbound", payload: body,
    headers: { "content-type": "application/json", "interakt-signature": sign(body) } });
};
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("full WA domino", () => {
  it("customer posts on WA → WA driver accepts → approve → WA confirm → customer books", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const placed: any[] = [];
    const el = { originateCall: async (a: any) => (placed.push(a), { conversationId: `v${placed.length}` }) };
    const app = buildServer({ pool, config, geo: fakeGeo as any, el: el as any, interakt: client });

    // WA-preference driver on the lane
    const owner = (await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "Ramesh", phone: "+919111111122", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }], channel: "whatsapp" } })).json();

    // drive the guided WA intake flow end to end (no LLM key set in test config)
    await waMsg(app, "+919888888811", "need a truck", "m1");
    await settle();
    // guided: from, to, vehicle (list), date (tomorrow), price, confirm
    await waMsg(app, "+919888888811", "Mumbai", "m2"); await settle();
    await waMsg(app, "+919888888811", "Pune", "m3"); await settle();
    await waMsg(app, "+919888888811", JSON.stringify({ type: "list_reply", list_reply: { id: "veh:16ft", title: "16ft" } }), "m4"); await settle();
    await waMsg(app, "+919888888811", JSON.stringify({ type: "button_reply", button_reply: { id: "date:tomorrow", title: "Tomorrow" } }), "m5"); await settle();
    await waMsg(app, "+919888888811", "13000", "m6"); await settle();
    await waMsg(app, "+919888888811", JSON.stringify({ type: "button_reply", button_reply: { id: "cfm:yes", title: "✅ Confirm" } }), "m7"); await settle();

    // demand sourced over WA: driver got a session-buttons offer (template is the cold-send fallback)
    const demands = (await app.inject({ method: "GET", url: "/demand", headers: auth })).json();
    expect(demands[0]).toMatchObject({ channel: "whatsapp", status: "SOURCING" });
    const offer = sent.find((s) => (s.kind === "buttons" || s.kind === "template") && s.to === "919111111122");
    expect(offer).toBeTruthy();
    const offerButtons = offer!.kind === "buttons" ? offer!.args[1] : null;
    const attemptId = (offerButtons ? (offerButtons[0].id as string) : (offer!.args[2]["0"][0] as string)).split(":")[1]; // acc:<attemptId>:<price>

    // driver taps Accept
    await waMsg(app, "+919111111122", JSON.stringify({ type: "button_reply", button_reply: { id: `acc:${attemptId}:13000`, title: "Accept" } }), "m8");
    await settle();
    let d = (await app.inject({ method: "GET", url: `/demand/${demands[0].id}`, headers: auth })).json();
    expect(d.status).toBe("DRIVER_LOCKED");
    expect(d.lockedPriceInr).toBe(13000);

    // dispatcher approves → WA confirm goes to the customer (no voice call)
    await app.inject({ method: "POST", url: `/demand/${d.id}/approve-driver`, headers: auth });
    expect(sent.some((s) => (s.kind === "buttons" || s.kind === "template") && s.to === "919888888811" && /Book|found/i.test(String(s.args[0])))).toBe(true);
    expect(placed).toHaveLength(0); // whole domino stayed on WhatsApp, no voice call placed

    // customer taps Confirm booking
    await waMsg(app, "+919888888811", JSON.stringify({ type: "button_reply", button_reply: { id: `bok:${d.id}`, title: "Confirm booking" } }), "m9");
    await settle();
    d = (await app.inject({ method: "GET", url: `/demand/${d.id}`, headers: auth })).json();
    expect(d.status).toBe("BOOKED");
  });
});
