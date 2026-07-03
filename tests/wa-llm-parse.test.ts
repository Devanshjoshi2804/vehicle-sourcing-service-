import { describe, it, expect, vi } from "vitest";
import { buildLoadParser } from "../src/wa/llm-parse.js";
import { loadConfig } from "../src/config.js";

const baseEnv = {
  DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w", PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
};
const EMPTY = { fromText: null, toText: null, vehicleType: null, priceInr: null, pickupDate: null };

describe("llm load parser", () => {
  it("returns empty without a key (guided flow takes over)", async () => {
    const parse = buildLoadParser(loadConfig(baseEnv as any));
    expect(await parse("16ft mumbai pune 13000", "2026-07-03")).toEqual(EMPTY);
  });

  it("extracts fields from Groq's JSON answer", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ fromText: "Mumbai", toText: "Pune", vehicleType: "16ft", priceInr: 13000, pickupDate: "2026-07-04" }) } }],
    }), { status: 200 })) as unknown as typeof fetch;
    const parse = buildLoadParser(loadConfig({ ...baseEnv, GROQ_API_KEY: "g" } as any), f);
    expect(await parse("16ft mumbai to pune 13000 kal", "2026-07-03")).toEqual({
      fromText: "Mumbai", toText: "Pune", vehicleType: "16ft", priceInr: 13000, pickupDate: "2026-07-04",
    });
    const req = JSON.parse((f as any).mock.calls[0][1].body);
    expect(req.response_format).toEqual({ type: "json_object" });
  });

  it("returns empty on API failure", async () => {
    const f = vi.fn(async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;
    const parse = buildLoadParser(loadConfig({ ...baseEnv, GROQ_API_KEY: "g" } as any), f);
    expect(await parse("anything", "2026-07-03")).toEqual(EMPTY);
  });
});
