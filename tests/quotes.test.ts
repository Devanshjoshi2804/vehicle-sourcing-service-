import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";
import { ElevenLabsClient } from "../src/calls/elevenlabs.client.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!,
  API_KEY: "k",
  WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p",
  MAX_CONCURRENT: "2",
  MAX_ATTEMPTS: "1",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };
const hook = { "x-webhook-secret": "w" };

describe("quotes read + ranking", () => {
  it("ranks YES+accepts_fixed first and filters", async () => {
    const { pool } = await withTestDb();
    let n = 0;
    const el: ElevenLabsClient = {
      async originateCall() {
        return { conversationId: `conv_${++n}` };
      },
    };
    const app = buildServer({ pool, config, el });

    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const o = await app.inject({
        method: "POST",
        url: "/owners",
        headers: auth,
        payload: { name: `O${i}`, phone: `+91900000010${i}`, vehicleTypes: ["16ft"], lanes: [] },
      });
      ids.push(o.json().id);
    }
    const load = await app.inject({
      method: "POST",
      url: "/loads",
      headers: auth,
      payload: {
        fromLocation: "A",
        toLocation: "B",
        vehicleType: "16ft",
        pickupDate: "2026-07-01",
        fixedPriceInr: 13000,
        createdBy: "d",
      },
    });
    const loadId = load.json().id;
    await app.inject({
      method: "POST",
      url: `/loads/${loadId}/call`,
      headers: auth,
      payload: { ownerIds: ids },
    });

    // conv_1 = NO, conv_2 = YES accepts fixed
    await app.inject({
      method: "POST",
      url: "/webhooks/report-availability",
      headers: hook,
      payload: { conversationId: "conv_1", available: "NO" },
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/report-availability",
      headers: hook,
      payload: { conversationId: "conv_2", available: "YES", acceptsFixed: true, quotedPriceInr: 13000 },
    });

    const all = await app.inject({
      method: "GET",
      url: `/loads/${loadId}/quotes`,
      headers: auth,
    });
    expect(all.json()[0].available).toBe("YES");
    expect(all.json()[0].acceptsFixed).toBe(true);

    const confirmed = await app.inject({
      method: "GET",
      url: `/loads/${loadId}/quotes?available=YES&acceptsFixed=true`,
      headers: auth,
    });
    expect(confirmed.json()).toHaveLength(1);
    await app.close();
  });

  it("manual follow-up returns 202", async () => {
    const { pool } = await withTestDb();
    let n = 0;
    const el: ElevenLabsClient = {
      async originateCall() {
        return { conversationId: `c_${++n}` };
      },
    };
    const app = buildServer({ pool, config, el });
    const o = await app.inject({
      method: "POST",
      url: "/owners",
      headers: auth,
      payload: { name: "O", phone: "+919000000300", vehicleTypes: ["16ft"], lanes: [] },
    });
    const load = await app.inject({
      method: "POST",
      url: "/loads",
      headers: auth,
      payload: {
        fromLocation: "A",
        toLocation: "B",
        vehicleType: "16ft",
        pickupDate: "2026-07-01",
        fixedPriceInr: 13000,
        createdBy: "d",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/loads/${load.json().id}/owners/${o.json().id}/followup`,
      headers: auth,
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });
});
