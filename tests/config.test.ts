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

  it("WA_ENABLED=false disables WhatsApp even with a key", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w",
      PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el",
      ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
      INTERAKT_API_KEY: "ik", WA_ENABLED: "false",
    } as NodeJS.ProcessEnv);
    expect(cfg.waEnabled).toBe(false);
  });

  it("parses vision/doc config with defaults", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w",
      PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el",
      ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
      GEMINI_API_KEY: "g",
    } as NodeJS.ProcessEnv);
    expect(cfg.geminiApiKey).toBe("g");
    expect(cfg.geminiModel).toBe("gemini-flash-latest");
    expect(cfg.mistralModel).toBe("pixtral-12b-2409");
    expect(cfg.lrCreateDailyCap).toBe(5);
    expect(cfg.docMaxBytes).toBe(8388608);
  });

  it("parses email config with defaults when IMAP creds are present", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w",
      PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el",
      ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
      IMAP_USER: "u@gmail.com", IMAP_PASSWORD: "app-pass",
    } as NodeJS.ProcessEnv);
    expect(cfg.imapHost).toBe("imap.gmail.com");
    expect(cfg.imapPort).toBe(993);
    expect(cfg.smtpHost).toBe("smtp.gmail.com");
    expect(cfg.smtpPort).toBe(465);
    expect(cfg.smtpSecure).toBe(true);
    expect(cfg.emailPollSeconds).toBe(30);
    expect(cfg.emailReplyTtlMin).toBe(120);
    expect(cfg.emailEnabled).toBe(true);
  });

  it("EMAIL_ENABLED=false disables email even with IMAP creds", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w",
      PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el",
      ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
      IMAP_USER: "u@gmail.com", IMAP_PASSWORD: "app-pass", EMAIL_ENABLED: "false",
    } as NodeJS.ProcessEnv);
    expect(cfg.emailEnabled).toBe(false);
  });

  it("emailEnabled is false without IMAP creds", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w",
      PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el",
      ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
    } as NodeJS.ProcessEnv);
    expect(cfg.emailEnabled).toBe(false);
  });
});
