import { describe, it, expect, vi } from "vitest";
import { buildElevenLabsClient } from "../src/calls/elevenlabs.client.js";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig({
  DATABASE_URL: "x",
  API_KEY: "k",
  WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el-key",
  ELEVENLABS_AGENT_SOURCING: "agent_1",
  ELEVENLABS_SIP_PHONE_ID: "phnum_1",
} as NodeJS.ProcessEnv);

describe("ElevenLabs client", () => {
  it("posts the agent + sip + dynamic vars and returns conversationId", async () => {
    const post = vi.fn().mockResolvedValue({ conversation_id: "conv_123" });
    const client = buildElevenLabsClient(cfg, post);
    const out = await client.originateCall({
      toNumber: "+919999999999",
      dynamicVariables: { flow: "offer" },
    });
    expect(out.conversationId).toBe("conv_123");
    const [url, body, headers] = post.mock.calls[0];
    expect(url).toContain("/convai/sip-trunk/outbound-call");
    expect(body.agent_id).toBe("agent_1");
    expect(body.agent_phone_number_id).toBe("phnum_1");
    expect(body.to_number).toBe("+919999999999");
    expect(body.conversation_initiation_client_data.dynamic_variables.flow).toBe("offer");
    expect(headers["xi-api-key"]).toBe("el-key");
  });

  it("throws when conversation_id missing", async () => {
    const client = buildElevenLabsClient(cfg, vi.fn().mockResolvedValue({}));
    await expect(
      client.originateCall({ toNumber: "+91", dynamicVariables: {} }),
    ).rejects.toThrow();
  });
});
