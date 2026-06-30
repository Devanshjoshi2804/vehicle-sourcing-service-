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

// fake geo: everything resolves to Mumbai so owner lane matching is deterministic
const fakeGeo: GeoResolver = {
  async resolveLocation(text) {
    return { raw: text, canonical: `${text}`, city: "Mumbai", state: "MH", lat: 19.1, lng: 72.8, source: "google" };
  },
};

function appWith(pool: any, calls: string[]) {
  let n = 0;
  const el: ElevenLabsClient = { async originateCall() { const c = `conv_${++n}`; calls.push(c); return { conversationId: c }; } };
  return buildServer({ pool, config, geo: fakeGeo, el });
}

async function seedDemand(app: any, conv: string, extra: any = {}) {
  const res = await app.inject({ method: "POST", url: "/webhooks/report-demand", headers: hook,
    payload: { conversationId: conv, customerPhone: "+919888888888", fromText: "andheri", toText: "pune",
      vehicleType: "16ft", offeredPriceInr: 12000, pickupDate: "2026-07-05", ...extra } });
  return res.json().demandId;
}

describe("demand dashboard routes", () => {
  it("lists NEW, rejects", async () => {
    const { pool } = await withTestDb();
    const app = appWith(pool, []);
    const id = await seedDemand(app, "d1");
    expect((await app.inject({ method: "GET", url: "/demand?status=NEW", headers: auth })).json()).toHaveLength(1);
    const rej = await app.inject({ method: "POST", url: `/demand/${id}/reject`, headers: auth });
    expect(rej.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/demand/${id}`, headers: auth })).json().status).toBe("REJECTED");
    await app.close();
  });

  it("a complete demand with a matching driver auto-sources on capture (no human step)", async () => {
    const { pool } = await withTestDb();
    const calls: string[] = [];
    const app = appWith(pool, calls);
    // owner whose lane Mumbai→Mumbai + 16ft matches the geocoded demand
    await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "Owner1", phone: "+919111111111", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Mumbai" }] } });
    const id = await seedDemand(app, "d2"); // report-demand auto-sources

    const d = (await app.inject({ method: "GET", url: `/demand/${id}`, headers: auth })).json();
    expect(d.status).toBe("SOURCING");
    expect(d.loadId).toBeTruthy();
    expect(calls).toHaveLength(1); // an outbound owner call was placed automatically

    const load = (await app.inject({ method: "GET", url: `/loads/${d.loadId}`, headers: auth })).json();
    expect(load.fixedPriceInr).toBe(12000); // the customer's offered price
    expect(load.vehicleType).toBe("16ft");

    // /approve is the NEW-only manual fallback → already SOURCING → 409
    const reAppr = await app.inject({ method: "POST", url: `/demand/${id}/approve`, headers: auth, payload: {} });
    expect(reAppr.statusCode).toBe(409);
    await app.close();
  });

  it("manual approve sources a demand that had no driver at capture", async () => {
    const { pool } = await withTestDb();
    const calls: string[] = [];
    const app = appWith(pool, calls);
    // no owners yet → the complete demand can't auto-source, stays NEW
    const id = await seedDemand(app, "d3");
    let d = (await app.inject({ method: "GET", url: `/demand/${id}`, headers: auth })).json();
    expect(d.status).toBe("NEW");
    expect(calls).toHaveLength(0);

    // a matching driver is added later; dispatcher sources by hand
    await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "Late", phone: "+919111111111", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Mumbai" }] } });
    const res = await app.inject({ method: "POST", url: `/demand/${id}/approve`, headers: auth, payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json().calledOwners).toBe(1);

    d = (await app.inject({ method: "GET", url: `/demand/${id}`, headers: auth })).json();
    expect(d.status).toBe("SOURCING");

    // double approve now 409
    const again = await app.inject({ method: "POST", url: `/demand/${id}/approve`, headers: auth, payload: {} });
    expect(again.statusCode).toBe(409);
    await app.close();
  });
});
