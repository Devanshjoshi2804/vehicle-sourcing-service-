import { FastifyInstance } from "fastify";
import { Config } from "../config.js";
import { verifyAttempt } from "./ivr.client.js";
import { Leg2Deps, recordDigit } from "./leg2.js";

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Plivo answer document: play the menu, wait for one key, post it back. The
// closing <Speak> covers the caller who presses nothing before the timeout.
export function answerXml(cfg: Config, attemptId: string, sig: string): string {
  const base = cfg.publicBaseUrl.replace(/\/$/, "");
  const action = xmlEscape(`${base}/ivr/digit?cid=${attemptId}&sig=${sig}`);
  const prompt = `नमस्ते। ${cfg.companyName} की ओर से कॉल है। अपने दस्तावेज़ भेजने के लिए एक दबाएं। रुचि नहीं है तो दो दबाएं।`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <GetDigits action="${action}" method="POST" numDigits="1" timeout="7" retries="1">
    <Speak language="hi-IN">${xmlEscape(prompt)}</Speak>
  </GetDigits>
  <Speak language="hi-IN">${xmlEscape("कोई इनपुट नहीं मिला। धन्यवाद।")}</Speak>
</Response>`;
}

// Plivo sends form-encoded bodies (and sometimes empty ones with the data in the
// query string) — the tolerant parsers in server.ts already normalise both, so
// read every field from body-or-query.
const field = (req: any, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = req.body?.[k] ?? req.query?.[k];
    if (v !== undefined && v !== null && String(v) !== "") return String(v);
  }
  return undefined;
};

export function registerIvrRoutes(app: FastifyInstance, deps: Leg2Deps) {
  const guard = (req: any, reply: any): string | null => {
    const cid = field(req, "cid") ?? "";
    const sig = field(req, "sig") ?? "";
    if (!cid || !verifyAttempt(deps.config.webhookSecret, cid, sig)) {
      reply.code(403).send({ error: "bad signature" });
      return null;
    }
    return cid;
  };

  app.get<{ Querystring: { cid: string; sig: string } }>("/ivr/answer", async (req, reply) => {
    const cid = guard(req, reply);
    if (!cid) return;
    return reply
      .type("text/xml")
      .send(answerXml(deps.config, cid, req.query.sig));
  });

  // Plivo POSTs the pressed key here. Always 200 with a spoken close, so the
  // provider never retries the leg.
  app.post("/ivr/digit", async (req, reply) => {
    const cid = guard(req, reply);
    if (!cid) return;
    const raw = field(req, "Digits", "digits");
    const digit = raw === "1" || raw === "2" ? raw : null;
    const seconds = Number(field(req, "Duration", "duration") ?? "") || null;

    await recordDigit(deps, cid, digit, seconds);

    const line =
      digit === "1"
        ? "धन्यवाद। हम आपको व्हाट्सएप पर लिंक भेज रहे हैं।"
        : digit === "2"
          ? "ठीक है, धन्यवाद।"
          : "कोई इनपुट नहीं मिला। धन्यवाद।";
    return reply
      .type("text/xml")
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response><Speak language="hi-IN">${xmlEscape(line)}</Speak></Response>`);
  });

  // Final call state. Only matters when the call never reached the keypad
  // (busy / no-answer / failed) — a completed call has already been recorded.
  app.post("/ivr/hangup", async (req, reply) => {
    const cid = guard(req, reply);
    if (!cid) return;
    const status = (field(req, "CallStatus", "call_status", "Status") ?? "").toLowerCase();
    if (status && status !== "completed") {
      const seconds = Number(field(req, "Duration", "duration") ?? "") || null;
      await recordDigit(deps, cid, null, seconds);
    }
    return reply.code(200).send({ ok: true });
  });
}
