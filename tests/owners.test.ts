import { describe, it, expect, beforeAll } from "vitest";
import { buildServer } from "../src/server.js";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";

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

describe("owners routes", () => {
  let app: ReturnType<typeof buildServer>;
  beforeAll(async () => {
    const { pool } = await withTestDb();
    app = buildServer({ pool, config });
  });

  it("rejects unauthenticated create", async () => {
    const res = await app.inject({ method: "POST", url: "/owners", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("creates and lists an owner", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/owners",
      headers: auth,
      payload: {
        name: "Ramesh",
        phone: "+919999999999",
        vehicleTypes: ["16ft"],
        lanes: [{ from: "Mumbai", to: "Pune" }],
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().id).toBeTruthy();

    const list = await app.inject({ method: "GET", url: "/owners", headers: auth });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].vehicleTypes).toEqual(["16ft"]);
  });

  it("rejects a bad phone", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/owners",
      headers: auth,
      payload: { name: "X", phone: "12345", vehicleTypes: [], lanes: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("owner channel defaults to voice, is patchable, and findByPhoneDigits matches", async () => {
    const { pool } = await withTestDb();
    const repo = new OwnersRepo(pool);
    const o = await repo.createOwner({ name: "R", phone: "+919111111199", vehicleTypes: ["16ft"], lanes: [] });
    expect(o.channel).toBe("voice");
    const upd = await repo.updateOwner(o.id, { channel: "whatsapp" } as any);
    expect(upd!.channel).toBe("whatsapp");
    const found = await repo.findByPhoneDigits("919111111199");
    expect(found!.id).toBe(o.id);
    expect(await repo.findByPhoneDigits("910000000000")).toBeNull();
  });
});
