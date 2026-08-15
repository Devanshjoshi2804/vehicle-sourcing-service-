import { buildServer } from "./server.js";
import { loadConfig } from "./config.js";
import { getPool } from "./db/pool.js";
import { startCallWatchdog } from "./calls/watchdog.js";
import { buildImapSource } from "./email/imap-source.js";
import { EmailMsg } from "./email/inbound.js";

const cfg = loadConfig();
const pool = getPool(cfg.databaseUrl);
const app = buildServer({ pool, config: cfg });
startCallWatchdog(pool, {
  staleMinutes: cfg.callStaleMinutes,
  waStaleMinutes: cfg.waReplyTtlMin,
  emailStaleMinutes: cfg.emailReplyTtlMin,
  campaignIvrStaleMinutes: cfg.campaignIvrStaleMinutes,
  log: (m) => app.log.info(m),
});

if (cfg.emailEnabled) {
  const emailRouter = (app as unknown as { emailRouter?: { handle(m: EmailMsg): Promise<void> } }).emailRouter;
  if (emailRouter) {
    const source = buildImapSource(cfg);
    source.start(async (m) => {
      try {
        await emailRouter.handle(m);
      } catch (err) {
        app.log.error({ err }, "[email] inbound processing failed");
      }
    });
  }
}

app.listen({ port: cfg.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
