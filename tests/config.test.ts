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

  it("parses WA/Interakt config with defaults", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w",
      PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el",
      ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
      INTERAKT_API_KEY: "ik", INTERAKT_WEBHOOK_SECRET: "ws",
    } as NodeJS.ProcessEnv);
    expect(cfg.interaktApiKey).toBe("ik");
    expect(cfg.interaktBaseUrl).toBe("https://api.interakt.ai/v1/public/message/");
    expect(cfg.interaktCountryCode).toBe("+91");
    expect(cfg.waEnabled).toBe(true);
    expect(cfg.waReplyTtlMin).toBe(30);
    expect(cfg.groqModel).toBe("llama-3.3-70b-versatile");
  });

  it("waEnabled is false without INTERAKT_API_KEY", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w",
      PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el",
      ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
    } as NodeJS.ProcessEnv);
    expect(cfg.waEnabled).toBe(false);
  });
});
