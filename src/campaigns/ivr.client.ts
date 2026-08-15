import crypto from "node:crypto";
import axios from "axios";
import { Config } from "../config.js";

type HttpPost = (
  url: string,
  body: unknown,
  opts: { auth: { username: string; password: string } },
) => Promise<any>;

const defaultPost: HttpPost = async (url, body, opts) => (await axios.post(url, body, opts)).data;

export type IvrDialer = {
  dial(attemptId: string, toNumber: string): Promise<{ callRef: string }>;
};

// The answer/digit URLs are public — Plivo cannot send our Bearer key — so each
// one carries an HMAC over the attempt id. Same reasoning as the email links.
export function signAttempt(secret: string, attemptId: string): string {
  return crypto.createHmac("sha256", secret).update(`ivr:${attemptId}`).digest("hex").slice(0, 32);
}

export function verifyAttempt(secret: string, attemptId: string, sig: string): boolean {
  const expected = signAttempt(secret, attemptId);
  const a = Buffer.from(String(sig ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Leg 2 is a keypad menu, not a conversation: Plivo plays our prompt and posts
// the pressed digit back. No media streaming, so the voice agent isn't involved.
export function buildIvrDialer(cfg: Config, httpPost: HttpPost = defaultPost): IvrDialer {
  return {
    async dial(attemptId, toNumber) {
      if (!cfg.plivoAuthId || !cfg.plivoAuthToken) throw new Error("PLIVO_AUTH_ID/TOKEN not set");
      if (!cfg.plivoCallerId) throw new Error("PLIVO_CALLER_ID not set");

      const sig = signAttempt(cfg.webhookSecret, attemptId);
      const answerUrl = `${cfg.publicBaseUrl.replace(/\/$/, "")}/ivr/answer?cid=${attemptId}&sig=${sig}`;
      const res = await httpPost(
        `https://api.plivo.com/v1/Account/${cfg.plivoAuthId}/Call/`,
        {
          from: cfg.plivoCallerId,
          to: toNumber,
          answer_url: answerUrl,
          answer_method: "GET",
          // Plivo posts the final call state here; we use it to close attempts
          // that never reached the keypad (busy, unanswered, failed).
          hangup_url: `${cfg.publicBaseUrl.replace(/\/$/, "")}/ivr/hangup?cid=${attemptId}&sig=${sig}`,
          hangup_method: "POST",
        },
        { auth: { username: cfg.plivoAuthId, password: cfg.plivoAuthToken } },
      );
      return { callRef: String(res?.request_uuid ?? attemptId) };
    },
  };
}
