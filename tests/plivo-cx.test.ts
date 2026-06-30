import { describe, it, expect } from "vitest";
import { buildPlivoCxClient } from "../src/calls/plivo-cx.client.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({
  DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w", PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
  VOICE_PROVIDER: "plivo", PLIVO_AGENTFLOW_URL: "https://agentflow.plivo.com/v1/account/X/flow/Y",
  COMPANY_NAME: "Pinified",
} as NodeJS.ProcessEnv);

describe("PlivoCxClient", () => {
  it("posts the 10 flow fields, dials owner_phone, and returns the conversation id it sent", async () => {
    const sent: { url: string; body: any; headers: any }[] = [];
    const client = buildPlivoCxClient(config, async (url, body, headers) => {
      sent.push({ url, body, headers });
      return { ok: true };
    });

    const { conversationId } = await client.originateCall({
      toNumber: "+919111111111",
      dynamicVariables: {
        flow: "offer", owner_name: "Ramesh", from: "Mumbai", to: "Pune",
        vehicle_type: "16ft", pickup_date: "2026-07-03", fixed_price: "13000", company: "Pinified",
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://agentflow.plivo.com/v1/account/X/flow/Y");
    const b = sent[0].body;
    // the id we return is exactly the one we passed in — so the agent's report matches
    expect(b.conversation_id).toBe(conversationId);
    expect(b.owner_phone).toBe("+919111111111"); // dialable number, not the route
    expect(b.to).toBe("Pune"); // route drop stays a place, never a number
    expect(b.fixed_price).toBe(13000); // numeric, per the flow's declared type
    expect(typeof b.fixed_price).toBe("number");
    expect(b).toMatchObject({
      company: "Pinified", flow: "offer", from: "Mumbai", owner_name: "Ramesh", vehicle_type: "16ft", pickup_date: "2026-07-03",
    });
  });

  it("throws if the trigger URL is not configured", async () => {
    const noUrl = loadConfig({
      DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w", PUBLIC_BASE_URL: "https://h",
      ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
      VOICE_PROVIDER: "plivo",
    } as NodeJS.ProcessEnv);
    const client = buildPlivoCxClient(noUrl, async () => ({}));
    await expect(client.originateCall({ toNumber: "+91", dynamicVariables: {} })).rejects.toThrow(/PLIVO_AGENTFLOW_URL/);
  });
});
