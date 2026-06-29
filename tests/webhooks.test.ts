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

async function setupCallingLoad(app: any) {
  const o = await app.inject({
    method: "POST",
    url: "/owners",
    headers: auth,
    payload: { name: "O", phone: "+919000000001", vehicleTypes: ["16ft"], lanes: [] },
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
  await app.inject({
    method: "POST",
    url: `/loads/${load.json().id}/call`,
    headers: auth,
    payload: { ownerIds: [o.json().id] },
  });
  return { ownerId: o.json().id, loadId: load.json().id };
}

describe("webhooks", () => {
  it("rejects without secret", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({
      pool,
      config,
      el: {
        async originateCall() {
          return { conversationId: "c1" };
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/report-availability",
      payload: { conversationId: "c1", available: "NO" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("writes a quote, is idempotent, and auto-queues follow-up when accepts_fixed=false", async () => {
    const { pool } = await withTestDb();
    const calls: string[] = [];
    let n = 0;
    const el: ElevenLabsClient = {
      async originateCall() {
        const c = `conv_${++n}`;
        calls.push(c);
        return { conversationId: c };
      },
    };
    const app = buildServer({ pool, config, el });
    await setupCallingLoad(app);

    // First offer call → conv_1. Owner available but rejects fixed price.
    const first = await app.inject({
      method: "POST",
      url: "/webhooks/report-availability",
      headers: hook,
      payload: {
        conversationId: "conv_1",
        available: "YES",
        acceptsFixed: false,
        quotedPriceInr: 15000,
        vehicleType: "16ft",
      },
    });
    expect(first.statusCode).toBe(201);

    // Idempotent replay of conv_1 → 200, not created.
    const replay = await app.inject({
      method: "POST",
      url: "/webhooks/report-availability",
      headers: hook,
      payload: { conversationId: "conv_1", available: "YES", acceptsFixed: false },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().created).toBe(false);

    // Auto follow-up should have placed a second call (conv_2).
    expect(calls).toContain("conv_2");

    // post-call attaches transcript + marks DONE
    await app.inject({
      method: "POST",
      url: "/webhooks/elevenlabs/post-call",
      headers: hook,
      payload: { conversationId: "conv_1", transcript: "namaste…" },
    });

    const { rows } = await pool.query(
      "SELECT transcript FROM quotes WHERE el_conversation_id='conv_1'",
    );
    expect(rows[0].transcript).toBe("namaste…");
    await app.close();
  });
});
