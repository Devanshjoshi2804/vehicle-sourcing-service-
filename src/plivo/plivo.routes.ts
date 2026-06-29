import { FastifyInstance } from "fastify";

// Plivo Answer URL. When a PSTN call hits the linked Plivo number, Plivo fetches
// this URL and we return Plivo XML that bridges the call into the ElevenLabs SIP
// agent via <Dial><Sip>. We forward the original caller's number as the SIP
// caller id so EL's {{system__caller_id}} (→ report_demand customerPhone) is real.
//
// No auth: Plivo calls it unauthenticated and it only ever returns static dial
// XML. Plivo posts application/x-www-form-urlencoded (From/To/CallUUID…); we also
// accept GET query params.
export function registerPlivoRoutes(app: FastifyInstance, sipUri: string) {
  // Parse form-urlencoded bodies (Plivo's default) without an extra plugin.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (e) {
        done(e as Error);
      }
    },
  );

  const handler = async (req: any, reply: any) => {
    const from = (req.body?.From ?? req.query?.From ?? "").toString().trim();
    const callerId = from ? ` callerId="${from}"` : "";
    // Plivo dials a SIP endpoint via <User> (NOT <Sip>, which is Twilio's element).
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<Response>\n` +
      `  <Dial${callerId}>\n` +
      `    <User>${sipUri}</User>\n` +
      `  </Dial>\n` +
      `</Response>`;
    reply.header("Content-Type", "application/xml").send(xml);
  };

  app.get("/plivo/answer", handler);
  app.post("/plivo/answer", handler);
}
