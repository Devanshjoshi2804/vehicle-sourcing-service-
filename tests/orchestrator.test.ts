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
  MAX_ATTEMPTS: "2",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };

describe("call orchestration", () => {
  it("fires calls, caps concurrency at 2, persists conversation ids", async () => {
    const { pool } = await withTestDb();
    let active = 0,
      peak = 0,
      n = 0;
    const el: ElevenLabsClient = {
      async originateCall() {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { conversationId: `conv_${++n}` };
      },
    };
    const app = buildServer({ pool, config, el });

    const ownerIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const o = await app.inject({
        method: "POST",
        url: "/owners",
        headers: auth,
        payload: { name: `O${i}`, phone: `+9190000000${i}0`, vehicleTypes: ["16ft"], lanes: [] },
      });
      ownerIds.push(o.json().id);
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
        fixedPriceInr: 100,
        createdBy: "d",
      },
    });

    const fire = await app.inject({
      method: "POST",
      url: `/loads/${load.json().id}/call`,
      headers: auth,
      payload: { ownerIds },
    });
    expect(fire.statusCode).toBe(202);
    expect(fire.json().queued).toBe(5);
    expect(peak).toBeLessThanOrEqual(2);

    const calls = await app.inject({
      method: "GET",
      url: `/loads/${load.json().id}/calls`,
      headers: auth,
    });
    const statuses = calls.json().map((c: any) => c.status);
    expect(statuses.filter((s: string) => s === "IN_PROGRESS")).toHaveLength(5);
    expect(calls.json().every((c: any) => c.elConversationId)).toBe(true);

    const loadAfter = await app.inject({
      method: "GET",
      url: `/loads/${load.json().id}`,
      headers: auth,
    });
    expect(loadAfter.json().status).toBe("CALLING");
    await app.close();
  });

  it("marks FAILED after retries when EL always throws", async () => {
    const { pool } = await withTestDb();
    const el: ElevenLabsClient = {
      async originateCall() {
        throw new Error("boom");
      },
    };
    const app = buildServer({ pool, config, el });
    const o = await app.inject({
      method: "POST",
      url: "/owners",
      headers: auth,
      payload: { name: "O", phone: "+919000000099", vehicleTypes: ["16ft"], lanes: [] },
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
        fixedPriceInr: 100,
        createdBy: "d",
      },
    });
    await app.inject({
      method: "POST",
      url: `/loads/${load.json().id}/call`,
      headers: auth,
      payload: { ownerIds: [o.json().id] },
    });
    const calls = await app.inject({
      method: "GET",
      url: `/loads/${load.json().id}/calls`,
      headers: auth,
    });
    expect(calls.json()[0].status).toBe("FAILED");
    await app.close();
  });
});
