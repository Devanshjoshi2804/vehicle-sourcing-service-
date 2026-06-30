import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: z.string().optional(),
  PORT: z.coerce.number().default(4200),
  API_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  PUBLIC_BASE_URL: z.string().min(1),
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_AGENT_SOURCING: z.string().min(1),
  ELEVENLABS_SIP_PHONE_ID: z.string().min(1),
  PLIVO_AUTH_ID: z.string().optional(),
  PLIVO_AUTH_TOKEN: z.string().optional(),
  // Who places outbound driver calls:
  //   elevenlabs   — EL SIP (legacy, fails India anchoring)
  //   plivo        — Plivo CX AgentFlow (no-code; its trial gates live-call audio)
  //   plivo_native — Plivo Call API → our own OVH voice agent (full control, works)
  VOICE_PROVIDER: z.enum(["elevenlabs", "plivo", "plivo_native"]).default("elevenlabs"),
  // The Plivo AgentFlow trigger URL (POST starts an outbound call with our vars).
  PLIVO_AGENTFLOW_URL: z.string().optional(),
  // plivo_native: the Caller ID to dial from, and the public base URL of our voice
  // agent whose /answer-outbound runs the driver-offer conversation.
  PLIVO_CALLER_ID: z.string().optional(),
  VOICE_AGENT_BASE: z.string().optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  // SIP URI the Plivo Answer-URL bridges inbound PSTN calls to (the EL agent).
  PLIVO_ANSWER_SIP_URI: z
    .string()
    .default("sip:+918065951377@sip.rtc.in.residency.elevenlabs.io;transport=tcp"),
  COMPANY_NAME: z.string().default("Pinified"),
  MAX_CONCURRENT: z.coerce.number().default(2),
  MAX_ATTEMPTS: z.coerce.number().default(2),
  // A call ringing / in-progress longer than this with no result is force-closed
  // by the watchdog (fixes calls stuck "on air" when no terminal webhook arrives).
  CALL_STALE_MINUTES: z.coerce.number().default(5),
});

export type Config = {
  databaseUrl: string;
  databaseUrlTest?: string;
  port: number;
  apiKey: string;
  webhookSecret: string;
  publicBaseUrl: string;
  elevenLabsApiKey: string;
  elevenLabsAgentId: string;
  elevenLabsSipPhoneId: string;
  plivoAuthId?: string;
  plivoAuthToken?: string;
  voiceProvider: "elevenlabs" | "plivo" | "plivo_native";
  plivoAgentflowUrl?: string;
  plivoCallerId?: string;
  voiceAgentBase?: string;
  googleMapsApiKey?: string;
  plivoAnswerSipUri: string;
  companyName: string;
  maxConcurrent: number;
  maxAttempts: number;
  callStaleMinutes: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const p = schema.parse(env);
  return {
    databaseUrl: p.DATABASE_URL,
    databaseUrlTest: p.DATABASE_URL_TEST,
    port: p.PORT,
    apiKey: p.API_KEY,
    webhookSecret: p.WEBHOOK_SECRET,
    publicBaseUrl: p.PUBLIC_BASE_URL,
    elevenLabsApiKey: p.ELEVENLABS_API_KEY,
    elevenLabsAgentId: p.ELEVENLABS_AGENT_SOURCING,
    elevenLabsSipPhoneId: p.ELEVENLABS_SIP_PHONE_ID,
    plivoAuthId: p.PLIVO_AUTH_ID,
    plivoAuthToken: p.PLIVO_AUTH_TOKEN,
    voiceProvider: p.VOICE_PROVIDER,
    plivoAgentflowUrl: p.PLIVO_AGENTFLOW_URL,
    plivoCallerId: p.PLIVO_CALLER_ID,
    voiceAgentBase: p.VOICE_AGENT_BASE,
    googleMapsApiKey: p.GOOGLE_MAPS_API_KEY,
    plivoAnswerSipUri: p.PLIVO_ANSWER_SIP_URI,
    companyName: p.COMPANY_NAME,
    maxConcurrent: p.MAX_CONCURRENT,
    maxAttempts: p.MAX_ATTEMPTS,
    callStaleMinutes: p.CALL_STALE_MINUTES,
  };
}
