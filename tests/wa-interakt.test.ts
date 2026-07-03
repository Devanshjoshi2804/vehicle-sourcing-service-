import { describe, it, expect, vi } from "vitest";
import { buildInteraktClient } from "../src/wa/interakt.client.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({
  DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w", PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
  INTERAKT_API_KEY: "ik-base64",
} as NodeJS.ProcessEnv);

function fakeFetch(body: any = { result: true }, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("interakt client", () => {
  it("splits phone into countryCode + 10 digits and sends Basic auth", async () => {
    const f = fakeFetch();
    await buildInteraktClient(config, f).sendText("919888888888", "hello");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.interakt.ai/v1/public/message/");
    expect(init.headers.Authorization).toBe("Basic ik-base64");
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ countryCode: "+91", phoneNumber: "9888888888", type: "Text", data: { message: "hello" } });
  });

  it("trims buttons to 3 × 20 chars and returns the trimmed options", async () => {
    const f = fakeFetch();
    const opts = await buildInteraktClient(config, f).sendButtons("919888888888", "pick", [
      { id: "a", title: "This title is way too long for WhatsApp" },
      { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" },
    ]);
    expect(opts).toHaveLength(3);
    expect(opts[0].title.length).toBe(20);
    const sent = JSON.parse((f as any).mock.calls[0][1].body);
    expect(sent.type).toBe("InteractiveButton");
    expect(sent.data.message.action.buttons).toHaveLength(3);
  });

  it("throws on result:false", async () => {
    const f = fakeFetch({ result: false, message: "template not found" });
    await expect(buildInteraktClient(config, f).sendText("919888888888", "x")).rejects.toThrow(/template not found/);
  });

  it("throws on http 500", async () => {
    const f = fakeFetch({}, 500);
    await expect(buildInteraktClient(config, f).sendText("919888888888", "x")).rejects.toThrow();
  });
});
