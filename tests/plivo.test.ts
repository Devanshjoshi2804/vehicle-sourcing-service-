import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", PLIVO_ANSWER_SIP_URI: "sip:+918065951377@sip.rtc.in.residency.elevenlabs.io;transport=tcp",
} as NodeJS.ProcessEnv);

describe("plivo answer url", () => {
  it("returns Dial>Sip XML to the EL agent (GET, no caller)", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config });
    const res = await app.inject({ method: "GET", url: "/plivo/answer" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("xml");
    expect(res.body).toContain("<Sip>sip:+918065951377@sip.rtc.in.residency.elevenlabs.io;transport=tcp</Sip>");
    expect(res.body).not.toContain("callerId");
    await app.close();
  });

  it("forwards the caller's number as callerId (POST form body)", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config });
    const res = await app.inject({
      method: "POST",
      url: "/plivo/answer",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "From=%2B919812345678&To=%2B918065951377&CallUUID=abc",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('callerId="+919812345678"');
    expect(res.body).toContain("<Sip>sip:+918065951377@");
    await app.close();
  });
});
