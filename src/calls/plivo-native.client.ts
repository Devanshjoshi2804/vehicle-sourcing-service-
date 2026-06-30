import { randomUUID } from "node:crypto";
import axios from "axios";
import { Config } from "../config.js";
import { ElevenLabsClient } from "./elevenlabs.client.js";

type HttpPost = (url: string, body: unknown, opts: { auth: { username: string; password: string } }) => Promise<any>;

const defaultPost: HttpPost = async (url, body, opts) => {
  const res = await axios.post(url, body, opts);
  return res.data;
};

// Places a real outbound call via the Plivo Call API, pointing the answer URL at
// OUR India-hosted voice agent (/answer-outbound). The agent runs the Hindi
// driver-offer conversation and reports back to /webhooks/report-availability.
//
// This is the path we fully control: Plivo only does telephony (media stays in
// India), our agent does the voice — no dependency on Plivo CX's gated runtime.
export function buildPlivoNativeClient(cfg: Config, httpPost: HttpPost = defaultPost): ElevenLabsClient {
  return {
    async originateCall({ toNumber, dynamicVariables: v }) {
      if (!cfg.plivoAuthId || !cfg.plivoAuthToken) throw new Error("PLIVO_AUTH_ID/TOKEN not set");
      if (!cfg.plivoCallerId) throw new Error("PLIVO_CALLER_ID not set (VOICE_PROVIDER=plivo_native)");
      if (!cfg.voiceAgentBase) throw new Error("VOICE_AGENT_BASE not set (VOICE_PROVIDER=plivo_native)");

      const conversationId = randomUUID();
      const params = new URLSearchParams({
        cid: conversationId,
        owner: v.owner_name ?? "",
        frm: v.from ?? "",
        to: v.to ?? "",
        vt: v.vehicle_type ?? "",
        price: v.fixed_price ?? "",
        flow: v.flow ?? "offer",
      });
      const answerUrl = `${cfg.voiceAgentBase.replace(/\/$/, "")}/answer-outbound?${params.toString()}`;

      await httpPost(
        `https://api.plivo.com/v1/Account/${cfg.plivoAuthId}/Call/`,
        {
          from: cfg.plivoCallerId,
          to: toNumber,
          answer_url: answerUrl,
          answer_method: "GET",
        },
        { auth: { username: cfg.plivoAuthId, password: cfg.plivoAuthToken } },
      );
      return { conversationId };
    },
  };
}
