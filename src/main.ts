import { buildServer } from "./server.js";
import { loadConfig } from "./config.js";
import { getPool } from "./db/pool.js";

const cfg = loadConfig();
const app = buildServer({ pool: getPool(cfg.databaseUrl), config: cfg });
app.listen({ port: cfg.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
