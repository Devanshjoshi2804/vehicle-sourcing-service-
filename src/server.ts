import Fastify, { FastifyInstance } from "fastify";
import pg from "pg";
import { Config } from "./config.js";
import { OwnersRepo } from "./owners/owners.repo.js";
import { registerOwnerRoutes } from "./owners/owners.routes.js";
import { LoadsRepo } from "./loads/loads.repo.js";
import { registerLoadRoutes } from "./loads/loads.routes.js";
import { CallsRepo } from "./calls/calls.repo.js";
import { buildElevenLabsClient, ElevenLabsClient } from "./calls/elevenlabs.client.js";
import { CallOrchestrator } from "./calls/orchestrator.js";
import { registerCallRoutes } from "./calls/calls.routes.js";
import { QuotesRepo } from "./quotes/quotes.repo.js";
import { registerQuoteRoutes } from "./quotes/quotes.routes.js";
import { registerWebhookRoutes } from "./webhooks/webhooks.routes.js";
import { DemandRepo } from "./demand/demand.repo.js";
import { buildGeoResolver, GeoResolver } from "./geo/geo.js";
import { requireApiKey } from "./auth.js";

export function buildServer(deps: {
  pool: pg.Pool;
  config: Config;
  el?: ElevenLabsClient;
  geo?: GeoResolver;
}): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get("/health", async () => ({ status: "ok" }));

  const preHandler = requireApiKey(deps.config.apiKey);
  const ownersRepo = new OwnersRepo(deps.pool);
  const loadsRepo = new LoadsRepo(deps.pool);
  const callsRepo = new CallsRepo(deps.pool);
  const el = deps.el ?? buildElevenLabsClient(deps.config);
  const orchestrator = new CallOrchestrator({
    pool: deps.pool,
    config: deps.config,
    el,
    ownersRepo,
    loadsRepo,
    callsRepo,
  });

  const quotesRepo = new QuotesRepo(deps.pool);
  const demandRepo = new DemandRepo(deps.pool);
  const geo = deps.geo ?? buildGeoResolver(deps.config);

  registerOwnerRoutes(app, ownersRepo, preHandler);
  registerLoadRoutes(app, loadsRepo, ownersRepo, preHandler);
  registerCallRoutes(app, orchestrator, callsRepo, preHandler);
  registerQuoteRoutes(app, { quotesRepo, orchestrator }, preHandler);
  registerWebhookRoutes(app, {
    quotesRepo,
    callsRepo,
    orchestrator,
    demandRepo,
    geo,
    secret: deps.config.webhookSecret,
  });
  return app;
}
