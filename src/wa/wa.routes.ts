import crypto from "node:crypto";
import { FastifyInstance } from "fastify";
import { Config } from "../config.js";
import { parseInbound } from "./inbound.js";
import { WaSessionsRepo } from "./wa-sessions.repo.js";
import { OwnersRepo } from "../owners/owners.repo.js";
import { handleDriverMessage, DriverFlowDeps } from "./driver-flow.js";
import { handleCustomerMessage, CustomerFlowDeps } from "./customer-flow.js";

export function registerWaRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    sessions: WaSessionsRepo;
    ownersRepo: OwnersRepo;
    driver: DriverFlowDeps;
    customer: CustomerFlowDeps;
  },
) {
  // Interakt signs webhooks: `Interakt-Signature: sha256=` + HMAC-SHA256(rawBody).
  // Skipped when no secret is configured (dev). Interakt wants a 200 within 3s,
  // so we verify + ack, then process off the request.
  app.post("/wa/inbound", async (req, reply) => {
    const secret = deps.config.interaktWebhookSecret;
    if (secret) {
      const sig = String(req.headers["interakt-signature"] ?? req.headers["x-interakt-signature"] ?? "");
      const raw = (req as any).rawBody ?? Buffer.from("");
      const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
      const a = Buffer.from(sig), b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return reply.code(401).send({ error: "bad signature" });
      }
    }
    const payload = req.body;
    reply.code(200).send({ status: "ok" });

    setImmediate(async () => {
      try {
        const probe = parseInbound(payload, []);
        if (!probe) return;
        const session = await deps.sessions.get(probe.from);
        const m = parseInbound(payload, session?.lastOptions ?? []);
        if (!m) return;
        // first-time senders need a session row before markProcessed can dedupe
        if (!session) {
          const owner = await deps.ownersRepo.findByPhoneDigits(m.from);
          await deps.sessions.upsert({ phone: m.from, role: owner ? "driver" : "customer", state: "IDLE" });
        }
        if (!(await deps.sessions.markProcessed(m.from, m.msgId))) return; // duplicate delivery

        const fresh = await deps.sessions.get(m.from);
        const owner = await deps.ownersRepo.findByPhoneDigits(m.from);

        // Interakt delivers one button tap as TWO events (the message + a
        // button-click status) with DIFFERENT message ids, so msgId dedup can't
        // catch it. Dedup on the resolved action within a short window instead.
        const actionKey =
          m.kind === "reply" ? `r:${m.replyId}` :
          m.kind === "media" ? `m:${m.mediaUrl}` :
          `t:${(m.text ?? "").trim().toLowerCase()}`;
        const last = (fresh?.ctx as any)?.lastInbound;
        if (last?.key === actionKey && Date.now() - Number(last.ts) < 45_000) return;
        // Role comes from the CURRENT owner match, not the cached session role —
        // deactivating (or deleting) a driver immediately makes their number a
        // customer, and adding an owner immediately makes it a driver.
        await deps.sessions.upsert({
          phone: m.from,
          role: owner ? "driver" : "customer",
          state: fresh?.state ?? "IDLE",
          ctx: { lastInbound: { key: actionKey, ts: Date.now() } },
        });

        if (owner) await handleDriverMessage(deps.driver, m, fresh, owner);
        else await handleCustomerMessage(deps.customer, m, fresh);
      } catch (e) {
        app.log.error({ err: e }, "[wa] inbound processing failed");
      }
    });
  });
}
