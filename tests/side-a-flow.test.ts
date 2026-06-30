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

function fakeEl() {
  const placed: { to: string; flow: string; conv: string; vars: Record<string, string> }[] = [];
  let n = 0;
  const el: ElevenLabsClient = {
    async originateCall({ toNumber, dynamicVariables }) {
      const conv = `conv_${++n}`;
      placed.push({ to: toNumber, flow: dynamicVariables.flow, conv, vars: dynamicVariables });
      return { conversationId: conv };
    },
  };
  return { el, placed };
}

describe("The domino: inbound demand → auto-call drivers → driver locks → company approves → customer booked", () => {
  it("runs the full chain in order", async () => {
    const { pool } = await withTestDb();
    const { el, placed } = fakeEl();
    const app = buildServer({ pool, config, geo: fakeGeo, el });

    // a driver that matches the (geocoded) route + vehicle
    await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "Driver1", phone: "+919111111111", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Mumbai" }] } });

    // 1. inbound customer call captured → AUTO-sources drivers (no human step)
    const cap = await app.inject({ method: "POST", url: "/webhooks/report-demand", headers: hook,
      payload: { conversationId: "inbound_1", customerPhone: "+919888888888", fromText: "andheri",
        toText: "pune", vehicleType: "16ft", offeredPriceInr: 12000, pickupDate: "2026-07-05" } });
    const body = cap.json();
    expect(body.sourced).toBe(true);
    expect(body.calledOwners).toBe(1);
    const demandId = body.demandId;
    expect(placed[0].flow).toBe("offer");
    expect(placed[0].to).toBe("+919111111111");

    // demand is SOURCING, no customer call placed yet
    let d = (await app.inject({ method: "GET", url: `/demand/${demandId}`, headers: auth })).json();
    expect(d.status).toBe("SOURCING");
    expect(placed.find((p) => p.flow === "customer_confirm")).toBeFalsy();

    // 2. driver accepts the fixed price → load LOCKS, customer NOT called yet
    const rep = await app.inject({ method: "POST", url: "/webhooks/report-availability", headers: hook,
      payload: { conversationId: placed[0].conv, available: "YES", acceptsFixed: true, quotedPriceInr: 12000 } });
    expect(rep.statusCode).toBe(201);
    d = (await app.inject({ method: "GET", url: `/demand/${demandId}`, headers: auth })).json();
    expect(d.status).toBe("DRIVER_LOCKED");
    expect(d.winningOwnerId).toBeTruthy();
    expect(placed.find((p) => p.flow === "customer_confirm")).toBeFalsy(); // still no customer call

    const load = (await app.inject({ method: "GET", url: `/loads/${d.loadId}`, headers: auth })).json();
    expect(load.status).toBe("LOCKED");

    // 3. company approves the value → NOW the customer is called
    const appr = await app.inject({ method: "POST", url: `/demand/${demandId}/approve-driver`, headers: auth });
    expect(appr.json().status).toBe("CUSTOMER_PENDING");
    const confirm = placed.find((p) => p.flow === "customer_confirm");
    expect(confirm).toBeTruthy();
    expect(confirm!.to).toBe("+919888888888");
    expect(confirm!.vars.load_id).toBe(d.loadId); // confirm flow can report back by load

    // 4. customer accepts on the confirm call → BOOKED
    const cust = await app.inject({ method: "POST", url: "/webhooks/customer-confirm", headers: hook,
      payload: { loadId: d.loadId, accepted: true } });
    expect(cust.statusCode).toBe(200);
    d = (await app.inject({ method: "GET", url: `/demand/${demandId}`, headers: auth })).json();
    expect(d.status).toBe("BOOKED");
    const booked = (await app.inject({ method: "GET", url: `/loads/${d.loadId}`, headers: auth })).json();
    expect(booked.status).toBe("BOOKED");
    await app.close();
  });

  it("does NOT auto-source an incomplete demand (no matching driver) — it stays NEW", async () => {
    const { pool } = await withTestDb();
    const { el, placed } = fakeEl();
    const app = buildServer({ pool, config, geo: fakeGeo, el });
    // no owners at all → nothing matches
    const cap = await app.inject({ method: "POST", url: "/webhooks/report-demand", headers: hook,
      payload: { conversationId: "inbound_2", customerPhone: "+919888888888", fromText: "x", toText: "y",
        vehicleType: "16ft", offeredPriceInr: 12000 } });
    const body = cap.json();
    expect(body.sourced).toBe(false);
    expect(placed.length).toBe(0);
    const d = (await app.inject({ method: "GET", url: `/demand/${body.demandId}`, headers: auth })).json();
    expect(d.status).toBe("NEW");
    await app.close();
  });

  it("first driver to accept wins; the others are superseded and the second accept is a no-op", async () => {
    const { pool } = await withTestDb();
    const { el, placed } = fakeEl();
    const app = buildServer({ pool, config, geo: fakeGeo, el });

    for (const [name, phone] of [["A", "+919111111111"], ["B", "+919222222222"]]) {
      await app.inject({ method: "POST", url: "/owners", headers: auth,
        payload: { name, phone, vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Mumbai" }] } });
    }
    const cap = (await app.inject({ method: "POST", url: "/webhooks/report-demand", headers: hook,
      payload: { conversationId: "inbound_3", customerPhone: "+919888888888", fromText: "a", toText: "b",
        vehicleType: "16ft", offeredPriceInr: 12000 } })).json();
    expect(cap.calledOwners).toBe(2);
    const demandId = cap.demandId;
    const [callA, callB] = placed.filter((p) => p.flow === "offer");

    // A accepts first → locks
    await app.inject({ method: "POST", url: "/webhooks/report-availability", headers: hook,
      payload: { conversationId: callA.conv, available: "YES", acceptsFixed: true } });
    let d = (await app.inject({ method: "GET", url: `/demand/${demandId}`, headers: auth })).json();
    expect(d.status).toBe("DRIVER_LOCKED");
    const winner = d.winningOwnerId;

    // B's call should now be SUPERSEDED
    const loadCalls = (await app.inject({ method: "GET", url: `/loads/${d.loadId}/calls`, headers: auth })).json();
    const bCall = loadCalls.find((c: any) => c.phone === "+919222222222");
    expect(bCall.status).toBe("SUPERSEDED");

    // B accepts too, late → no-op, winner unchanged
    await app.inject({ method: "POST", url: "/webhooks/report-availability", headers: hook,
      payload: { conversationId: callB.conv, available: "YES", acceptsFixed: true } });
    d = (await app.inject({ method: "GET", url: `/demand/${demandId}`, headers: auth })).json();
    expect(d.status).toBe("DRIVER_LOCKED");
    expect(d.winningOwnerId).toBe(winner);
    await app.close();
  });
});
