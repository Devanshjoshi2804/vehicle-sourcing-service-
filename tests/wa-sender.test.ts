import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fakeInterakt } from "./helpers/wa.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1", INTERAKT_API_KEY: "ik",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };

describe("wa channel in the orchestrator", () => {
  it("whatsapp-preference owner gets a WA offer (session buttons first), not a voice call", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const placed: any[] = [];
    const el = { originateCall: async (a: any) => (placed.push(a), { conversationId: `c${placed.length}` }) };
    const app = buildServer({ pool, config, el, interakt: client });

    const owner = (await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "W", phone: "+919111111177", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }], channel: "whatsapp" } })).json();
    const load = (await app.inject({ method: "POST", url: "/loads", headers: auth,
      payload: { fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" } })).json();
    await app.inject({ method: "POST", url: `/loads/${load.id}/call`, headers: auth, payload: { ownerIds: [owner.id] } });

    expect(placed).toHaveLength(0);
    expect(sent.filter((s) => s.kind === "buttons")).toHaveLength(1); // session send; template is the cold fallback
    const calls = (await app.inject({ method: "GET", url: `/loads/${load.id}/calls`, headers: auth })).json();
    expect(calls[0]).toMatchObject({ channel: "wa", status: "IN_PROGRESS" });
    expect(calls[0].elConversationId).toBe(`wa_${calls[0].id}`);
  });

  it("falls back to a voice call when the WA send fails", async () => {
    const { pool } = await withTestDb();
    const { client } = fakeInterakt(true); // buttons AND template sends throw
    const placed: any[] = [];
    const el = { originateCall: async (a: any) => (placed.push(a), { conversationId: `c${placed.length}` }) };
    const app = buildServer({ pool, config, el, interakt: client });

    const owner = (await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "W2", phone: "+919111111166", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }], channel: "whatsapp" } })).json();
    const load = (await app.inject({ method: "POST", url: "/loads", headers: auth,
      payload: { fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" } })).json();
    await app.inject({ method: "POST", url: `/loads/${load.id}/call`, headers: auth, payload: { ownerIds: [owner.id] } });

    expect(placed).toHaveLength(1); // voice fallback dialed
    const calls = (await app.inject({ method: "GET", url: `/loads/${load.id}/calls`, headers: auth })).json();
    expect(calls[0].channel).toBe("voice"); // fell back
  });
});
