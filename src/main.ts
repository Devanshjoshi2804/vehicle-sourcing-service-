import { buildServer } from "./server.js";
import { loadConfig } from "./config.js";
import { getPool } from "./db/pool.js";
import { startCallWatchdog } from "./calls/watchdog.js";

const cfg = loadConfig();
const pool = getPool(cfg.databaseUrl);
const app = buildServer({ pool, config: cfg });
startCallWatchdog(pool, {
  staleMinutes: cfg.callStaleMinutes,
  waStaleMinutes: cfg.waReplyTtlMin,
  emailStaleMinutes: cfg.emailReplyTtlMin,
  log: (m) => app.log.info(m),
});
app.listen({ port: cfg.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
