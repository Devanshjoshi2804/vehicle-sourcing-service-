import { describe, it, expect, beforeAll } from "vitest";
import { buildServer } from "../src/server.js";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!,
  API_KEY: "k",
  WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };
const payload = {
  fromLocation: "Mumbai",
  toLocation: "Pune",
  vehicleType: "16ft",
  pickupDate: "2026-07-01",
  fixedPriceInr: 13000,
  createdBy: "disp1",
};

describe("loads routes", () => {
  let app: ReturnType<typeof buildServer>;
  beforeAll(async () => {
    const { pool } = await withTestDb();
    app = buildServer({ pool, config });
  });

  it("creates a DRAFT load", async () => {
    const res = await app.inject({ method: "POST", url: "/loads", headers: auth, payload });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("DRAFT");
    expect(res.json().fixedPriceInr).toBe(13000);
    // pickupDate must round-trip exactly (no timezone off-by-one)
    expect(res.json().pickupDate).toBe("2026-07-01");
  });

  it("closes a load", async () => {
    const created = await app.inject({ method: "POST", url: "/loads", headers: auth, payload });
    const id = created.json().id;
    const closed = await app.inject({ method: "POST", url: `/loads/${id}/close`, headers: auth });
    expect(closed.statusCode).toBe(200);
    const got = await app.inject({ method: "GET", url: `/loads/${id}`, headers: auth });
    expect(got.json().status).toBe("CLOSED");
  });

  it("suggests matching active owners ranked by score", async () => {
    await app.inject({
      method: "POST",
      url: "/owners",
      headers: auth,
      payload: {
        name: "Match",
        phone: "+919111111111",
        vehicleTypes: ["16ft"],
        lanes: [{ from: "Mumbai", to: "Pune" }],
      },
    });
    await app.inject({
      method: "POST",
      url: "/owners",
      headers: auth,
      payload: {
        name: "NoVeh",
        phone: "+919222222222",
        vehicleTypes: ["32ft"],
        lanes: [{ from: "Mumbai", to: "Pune" }],
      },
    });
    const load = await app.inject({ method: "POST", url: "/loads", headers: auth, payload });
    const res = await app.inject({
      method: "GET",
      url: `/loads/${load.json().id}/suggested-owners`,
      headers: auth,
    });
    const names = res.json().map((r: any) => r.owner.name);
    expect(names).toContain("Match");
    expect(names).not.toContain("NoVeh");
  });
});
