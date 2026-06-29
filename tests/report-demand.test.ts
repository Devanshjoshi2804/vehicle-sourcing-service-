import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";
import { GeoResolver } from "../src/geo/geo.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p",
} as NodeJS.ProcessEnv);
const hook = { "x-webhook-secret": "w" };

const fakeGeo: GeoResolver = {
  async resolveLocation(text) {
    return { raw: text, canonical: `${text} (resolved)`, city: "Mumbai", state: "MH", lat: 19.1, lng: 72.8, source: "google" };
  },
};

const body = {
  conversationId: "demand_conv_1",
  customerPhone: "+919888888888",
  fromText: "andheri east",
  toText: "hinjewadi pune",
  vehicleType: "16ft",
  offeredPriceInr: 12000,
  pickupDate: "2026-07-05",
  note: "need today",
};

describe("report-demand webhook", () => {
  it("rejects without secret", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config, geo: fakeGeo });
    const res = await app.inject({ method: "POST", url: "/webhooks/report-demand", payload: body });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("geocodes and stores a NEW demand request, idempotently", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config, geo: fakeGeo });

    const first = await app.inject({ method: "POST", url: "/webhooks/report-demand", headers: hook, payload: body });
    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);

    const { rows } = await pool.query("SELECT * FROM demand_requests WHERE el_conversation_id='demand_conv_1'");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("NEW");
    expect(rows[0].offered_price_inr).toBe(12000);
    expect(rows[0].from_resolved.city).toBe("Mumbai");
    expect(rows[0].from_resolved.canonical).toBe("andheri east (resolved)");

    const replay = await app.inject({ method: "POST", url: "/webhooks/report-demand", headers: hook, payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().created).toBe(false);
    await app.close();
  });

  it("400s on a malformed pickup date", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config, geo: fakeGeo });
    const res = await app.inject({ method: "POST", url: "/webhooks/report-demand", headers: hook,
      payload: { ...body, conversationId: "x2", pickupDate: "05-07-2026" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
