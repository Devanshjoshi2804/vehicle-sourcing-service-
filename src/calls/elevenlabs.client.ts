import axios from "axios";
import { Config } from "../config.js";

export type OriginateInput = { toNumber: string; dynamicVariables: Record<string, string> };
export interface ElevenLabsClient {
  originateCall(input: OriginateInput): Promise<{ conversationId: string }>;
}

type HttpPost = (url: string, body: unknown, headers: Record<string, string>) => Promise<any>;

const defaultPost: HttpPost = async (url, body, headers) => {
  const res = await axios.post(url, body, { headers });
  return res.data;
};

export function buildElevenLabsClient(cfg: Config, httpPost: HttpPost = defaultPost): ElevenLabsClient {
  const url = "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call";
  return {
    async originateCall({ toNumber, dynamicVariables }) {
      const data = await httpPost(
        url,
        {
          agent_id: cfg.elevenLabsAgentId,
          agent_phone_number_id: cfg.elevenLabsSipPhoneId,
          to_number: toNumber,
          conversation_initiation_client_data: { dynamic_variables: dynamicVariables },
        },
        { "xi-api-key": cfg.elevenLabsApiKey, "Content-Type": "application/json" },
      );
      const conversationId = data.conversation_id ?? data.conversationId;
      if (!conversationId) throw new Error("ElevenLabs: no conversation_id in response");
      return { conversationId };
    },
  };
}
