import { randomUUID } from "node:crypto";
import axios from "axios";
import { Config } from "../config.js";
import { ElevenLabsClient } from "./elevenlabs.client.js";

type HttpPost = (url: string, body: unknown, headers: Record<string, string>) => Promise<any>;

const defaultPost: HttpPost = async (url, body, headers) => {
  const res = await axios.post(url, body, { headers });
  return res.data;
};

// Triggers a Plivo CX AgentFlow to place one outbound driver call. Plivo dials
// `owner_phone` from the body and uses the Caller ID configured on the flow.
//
// We generate `conversation_id` ourselves and pass it in (rather than using
// Plivo's call uuid), so the id the agent echoes back to /webhooks/report-
// availability always matches the call_attempt we just stored — independent of
// whatever Plivo's trigger response returns.
export function buildPlivoCxClient(cfg: Config, httpPost: HttpPost = defaultPost): ElevenLabsClient {
  const url = cfg.plivoAgentflowUrl;
  return {
    async originateCall({ toNumber, dynamicVariables: v }) {
      if (!url) throw new Error("PLIVO_AGENTFLOW_URL not set (VOICE_PROVIDER=plivo)");
      const conversationId = randomUUID();
      // String fields for the query string. The flow reads these as
      // {{Start.http.params.X}} — query params populate that reliably, where a
      // JSON body did not (it left the greeting + report conversation_id empty).
      const fields: Record<string, string> = {
        company: v.company ?? cfg.companyName,
        conversation_id: conversationId,
        fixed_price: String(v.fixed_price ?? ""),
        flow: v.flow ?? "offer",
        from: v.from ?? "",
        owner_name: v.owner_name ?? "",
        owner_phone: toNumber, // the dialable E.164 number Plivo calls
        pickup_date: v.pickup_date ?? "",
        to: v.to ?? "",
        vehicle_type: v.vehicle_type ?? "",
      };
      const qs = new URLSearchParams(fields).toString();
      const triggerUrl = `${url}${url.includes("?") ? "&" : "?"}${qs}`;
      // Send both: query params (for Start.http.params) AND the JSON body (belt
      // and suspenders, with a numeric fixed_price as the flow's schema expects).
      const body = { ...fields, fixed_price: Number(fields.fixed_price || 0) };
      await httpPost(triggerUrl, body, { "Content-Type": "application/json" });
      return { conversationId };
    },
  };
}
