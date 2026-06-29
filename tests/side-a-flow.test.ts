import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";
import { GeoResolver } from "../src/geo/geo.js";
import { ElevenLabsClient } from "../src/calls/elevenlabs.client.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };
const hook = { "x-webhook-secret": "w" };
const fakeGeo: GeoResolver = {
  async resolveLocation(text) {
    return { raw: text, canonical: text, city: "Mumbai", state: "MH", lat: 19.1, lng: 72.8, source: "google" };
  },
};

describe("Side A end-to-end: inbound demand → approve → owner accepts → customer confirmed", () => {
  it("runs the full loop", async () => {
    const { pool } = await withTestDb();
    const placed: { to: string; flow: string; conv: string }[] = [];
    let n = 0;
    const el: ElevenLabsClient = {
      async originateCall({ toNumber, dynamicVariables }) {
        const conv = `conv_${++n}`;
        placed.push({ to: toNumber, flow: dynamicVariables.flow, conv });
        return { conversationId: conv };
      },
    };
    const app = buildServer({ pool, config, geo: fakeGeo, el });

    // an owner that matches the (geocoded) route + vehicle
    await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "Owner1", phone: "+919111111111", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Mumbai" }] } });

    // 1. inbound customer call captured
    const demandId = (await app.inject({ method: "POST", url: "/webhooks/report-demand", headers: hook,
      payload: { conversationId: "inbound_1", customerPhone: "+919888888888", fromText: "andheri",
        toText: "pune", vehicleType: "16ft", offeredPriceInr: 12000, pickupDate: "2026-07-05" } })).json().demandId;

    // 2. company approves → load created + owner called
    const appr = await app.inject({ method: "POST", url: `/demand/${demandId}/approve`, headers: auth, payload: {} });
    expect(appr.json().calledOwners).toBe(1);
    expect(placed[0].flow).toBe("offer");
    expect(placed[0].to).toBe("+919111111111");

    // 3. owner accepts the price on that call → customer should be confirmed
    const ownerCallConv = placed[0].conv;
    const rep = await app.inject({ method: "POST", url: "/webhooks/report-availability", headers: hook,
      payload: { conversationId: ownerCallConv, available: "YES", acceptsFixed: true, quotedPriceInr: 12000 } });
    expect(rep.statusCode).toBe(201);

    // a customer_confirm call was placed to the customer's number
    const confirm = placed.find((p) => p.flow === "customer_confirm");
    expect(confirm).toBeTruthy();
    expect(confirm!.to).toBe("+919888888888");

    // demand is CONFIRMED
    const d = (await app.inject({ method: "GET", url: `/demand/${demandId}`, headers: auth })).json();
    expect(d.status).toBe("CONFIRMED");
    await app.close();
  });
});
