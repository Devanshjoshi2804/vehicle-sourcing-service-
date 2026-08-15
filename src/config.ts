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
  // WhatsApp channel via Interakt (BSP). WA is enabled iff an API key is set
  // AND WA_ENABLED isn't explicitly turned off.
  INTERAKT_API_KEY: z.string().optional(),
  INTERAKT_BASE_URL: z.string().default("https://api.interakt.ai/v1/public/message/"),
  INTERAKT_WEBHOOK_SECRET: z.string().optional(),
  INTERAKT_COUNTRY_CODE: z.string().default("+91"),
  WA_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  WA_REPLY_TTL_MIN: z.coerce.number().default(30),
  // LLM parse of free-text customer loads (optional — guided flow without it)
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),
  // Vision extraction of driver documents (LR/invoice photos). Optional — the
  // doc pipeline stores docs UNPROCESSED without a key.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_MODEL: z.string().default("pixtral-12b-2409"),
  LR_CREATE_DAILY_CAP: z.coerce.number().default(5),
  DOC_MAX_BYTES: z.coerce.number().default(8_388_608),
  // Email channel (IMAP poll + SMTP send). Enabled iff IMAP creds are present
  // AND EMAIL_ENABLED isn't explicitly turned off — same pattern as WA_ENABLED.
  EMAIL_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  IMAP_HOST: z.string().default("imap.gmail.com"),
  IMAP_PORT: z.coerce.number().default(993),
  IMAP_USER: z.string().optional(),
  IMAP_PASSWORD: z.string().optional(),
  SMTP_HOST: z.string().default("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_SECURE: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  EMAIL_POLL_SECONDS: z.coerce.number().default(30),
  EMAIL_REPLY_TTL_MIN: z.coerce.number().default(120),
  // --- Campaign outreach (CSV list → WhatsApp → IVR → manual queue) ---
  // Approved Interakt template for the leg-1 blast: 1 body var (contact name),
  // 2 quick-reply buttons.
  CAMPAIGN_TEMPLATE: z.string().default("doc_verification_request"),
  // How long a leg-1 contact may sit unanswered before it is marked no-reply
  // (WhatsApp's template window is 24h).
  CAMPAIGN_L1_WINDOW_MIN: z.coerce.number().default(1440),
  // Dials per IVR contact before it escalates to the manual queue.
  CAMPAIGN_IVR_ATTEMPTS: z.coerce.number().default(2),
  // A dialed IVR call with no digit webhook is force-closed after this.
  CAMPAIGN_IVR_STALE_MINUTES: z.coerce.number().default(10),
  // Where magic-link document uploads are written (a docker volume in prod).
  UPLOAD_DIR: z.string().default("/data/uploads"),
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
  interaktApiKey?: string;
  interaktBaseUrl: string;
  interaktWebhookSecret?: string;
  interaktCountryCode: string;
  waEnabled: boolean;
  waReplyTtlMin: number;
  groqApiKey?: string;
  groqModel: string;
  geminiApiKey?: string;
  geminiModel: string;
  mistralApiKey?: string;
  mistralModel: string;
  lrCreateDailyCap: number;
  docMaxBytes: number;
  emailEnabled: boolean;
  imapHost: string;
  imapPort: number;
  imapUser?: string;
  imapPassword?: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  emailPollSeconds: number;
  emailReplyTtlMin: number;
  campaignTemplate: string;
  campaignL1WindowMin: number;
  campaignIvrAttempts: number;
  campaignIvrStaleMinutes: number;
  uploadDir: string;
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
    interaktApiKey: p.INTERAKT_API_KEY,
    interaktBaseUrl: p.INTERAKT_BASE_URL,
    interaktWebhookSecret: p.INTERAKT_WEBHOOK_SECRET,
    interaktCountryCode: p.INTERAKT_COUNTRY_CODE,
    waEnabled: Boolean(p.INTERAKT_API_KEY) && p.WA_ENABLED,
    waReplyTtlMin: p.WA_REPLY_TTL_MIN,
    groqApiKey: p.GROQ_API_KEY,
    groqModel: p.GROQ_MODEL,
    geminiApiKey: p.GEMINI_API_KEY,
    geminiModel: p.GEMINI_MODEL,
    mistralApiKey: p.MISTRAL_API_KEY,
    mistralModel: p.MISTRAL_MODEL,
    lrCreateDailyCap: p.LR_CREATE_DAILY_CAP,
    docMaxBytes: p.DOC_MAX_BYTES,
    emailEnabled: Boolean(p.IMAP_USER) && Boolean(p.IMAP_PASSWORD) && p.EMAIL_ENABLED,
    imapHost: p.IMAP_HOST,
    imapPort: p.IMAP_PORT,
    imapUser: p.IMAP_USER,
    imapPassword: p.IMAP_PASSWORD,
    smtpHost: p.SMTP_HOST,
    smtpPort: p.SMTP_PORT,
    smtpSecure: p.SMTP_SECURE,
    smtpUser: p.SMTP_USER,
    smtpPass: p.SMTP_PASS,
    smtpFrom: p.SMTP_FROM,
    emailPollSeconds: p.EMAIL_POLL_SECONDS,
    emailReplyTtlMin: p.EMAIL_REPLY_TTL_MIN,
    campaignTemplate: p.CAMPAIGN_TEMPLATE,
    campaignL1WindowMin: p.CAMPAIGN_L1_WINDOW_MIN,
    campaignIvrAttempts: p.CAMPAIGN_IVR_ATTEMPTS,
    campaignIvrStaleMinutes: p.CAMPAIGN_IVR_STALE_MINUTES,
    uploadDir: p.UPLOAD_DIR,
  };
}
