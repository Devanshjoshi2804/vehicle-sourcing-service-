import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("parses required env and applies numeric defaults", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x",
      API_KEY: "k",
      WEBHOOK_SECRET: "w",
      PUBLIC_BASE_URL: "https://h",
      ELEVENLABS_API_KEY: "el",
      ELEVENLABS_AGENT_SOURCING: "agent_1",
      ELEVENLABS_SIP_PHONE_ID: "phnum_1",
    } as NodeJS.ProcessEnv);
    expect(cfg.databaseUrl).toBe("postgres://x");
    expect(cfg.maxConcurrent).toBe(2);
    expect(cfg.companyName).toBe("Pinified");
  });

  it("throws when a required key is missing", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow();
  });
});
