import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";

describe("GET /health", () => {
  it("returns ok", async () => {
    const { pool } = await withTestDb();
    const config = loadConfig({
      DATABASE_URL: process.env.DATABASE_URL_TEST!,
      API_KEY: "k",
      WEBHOOK_SECRET: "w",
      PUBLIC_BASE_URL: "https://h",
      ELEVENLABS_API_KEY: "el",
      ELEVENLABS_AGENT_SOURCING: "a",
      ELEVENLABS_SIP_PHONE_ID: "p",
    } as NodeJS.ProcessEnv);
    const app = buildServer({ pool, config });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
