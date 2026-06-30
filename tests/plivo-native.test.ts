import { describe, it, expect } from "vitest";
import { buildPlivoNativeClient } from "../src/calls/plivo-native.client.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({
  DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w", PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
  VOICE_PROVIDER: "plivo_native", PLIVO_AUTH_ID: "MAID", PLIVO_AUTH_TOKEN: "tok",
  PLIVO_CALLER_ID: "+918065951377", VOICE_AGENT_BASE: "https://voice.example.io", COMPANY_NAME: "Pinified",
} as NodeJS.ProcessEnv);

describe("PlivoNativeClient", () => {
  it("calls the Plivo Call API with our agent's answer URL + load context", async () => {
    const sent: { url: string; body: any; opts: any }[] = [];
    const client = buildPlivoNativeClient(config, async (url, body, opts) => {
      sent.push({ url, body, opts });
      return { request_uuid: "r1" };
    });

    const { conversationId } = await client.originateCall({
      toNumber: "+919111111111",
      dynamicVariables: {
        flow: "offer", owner_name: "Ramesh", from: "Mumbai", to: "Pune",
        vehicle_type: "16ft", pickup_date: "2026-07-03", fixed_price: "13000", company: "Pinified",
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.plivo.com/v1/Account/MAID/Call/");
    expect(sent[0].body.from).toBe("+918065951377"); // caller id
    expect(sent[0].body.to).toBe("+919111111111"); // owner dialed
    expect(sent[0].opts.auth).toEqual({ username: "MAID", password: "tok" });
    const u = new URL(sent[0].body.answer_url);
    expect(u.origin + u.pathname).toBe("https://voice.example.io/answer-outbound");
    expect(u.searchParams.get("cid")).toBe(conversationId); // matchable id
    expect(u.searchParams.get("frm")).toBe("Mumbai");
    expect(u.searchParams.get("to")).toBe("Pune");
    expect(u.searchParams.get("price")).toBe("13000");
    expect(u.searchParams.get("owner")).toBe("Ramesh");
  });

  it("throws when caller id or agent base is missing", async () => {
    const bad = loadConfig({
      DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w", PUBLIC_BASE_URL: "https://h",
      ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
      VOICE_PROVIDER: "plivo_native", PLIVO_AUTH_ID: "MAID", PLIVO_AUTH_TOKEN: "tok",
    } as NodeJS.ProcessEnv);
    const client = buildPlivoNativeClient(bad, async () => ({}));
    await expect(client.originateCall({ toNumber: "+91", dynamicVariables: {} })).rejects.toThrow(/PLIVO_CALLER_ID/);
  });
});
