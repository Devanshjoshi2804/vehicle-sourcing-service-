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
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  // SIP URI the Plivo Answer-URL bridges inbound PSTN calls to (the EL agent).
  PLIVO_ANSWER_SIP_URI: z
    .string()
    .default("sip:+918065951377@sip.rtc.in.residency.elevenlabs.io;transport=tcp"),
  COMPANY_NAME: z.string().default("Pinified"),
  MAX_CONCURRENT: z.coerce.number().default(2),
  MAX_ATTEMPTS: z.coerce.number().default(2),
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
  googleMapsApiKey?: string;
  plivoAnswerSipUri: string;
  companyName: string;
  maxConcurrent: number;
  maxAttempts: number;
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
    googleMapsApiKey: p.GOOGLE_MAPS_API_KEY,
    plivoAnswerSipUri: p.PLIVO_ANSWER_SIP_URI,
    companyName: p.COMPANY_NAME,
    maxConcurrent: p.MAX_CONCURRENT,
    maxAttempts: p.MAX_ATTEMPTS,
  };
}
