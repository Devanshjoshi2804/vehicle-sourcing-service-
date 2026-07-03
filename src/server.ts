import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import pg from "pg";
import { Config } from "./config.js";
import { OwnersRepo } from "./owners/owners.repo.js";
import { registerOwnerRoutes } from "./owners/owners.routes.js";
import { LoadsRepo } from "./loads/loads.repo.js";
import { registerLoadRoutes } from "./loads/loads.routes.js";
import { CallsRepo } from "./calls/calls.repo.js";
import { buildElevenLabsClient, ElevenLabsClient } from "./calls/elevenlabs.client.js";
import { buildPlivoCxClient } from "./calls/plivo-cx.client.js";
import { buildPlivoNativeClient } from "./calls/plivo-native.client.js";
import { CallOrchestrator } from "./calls/orchestrator.js";
import { registerCallRoutes } from "./calls/calls.routes.js";
import { QuotesRepo } from "./quotes/quotes.repo.js";
import { registerQuoteRoutes } from "./quotes/quotes.routes.js";
import { registerWebhookRoutes } from "./webhooks/webhooks.routes.js";
import { DemandRepo } from "./demand/demand.repo.js";
import { registerDemandRoutes } from "./demand/demand.routes.js";
import { buildGeoResolver, GeoResolver } from "./geo/geo.js";
import { registerPlivoRoutes } from "./plivo/plivo.routes.js";
import { requireApiKey } from "./auth.js";
import { buildInteraktClient, InteraktClient } from "./wa/interakt.client.js";
import { WaSessionsRepo } from "./wa/wa-sessions.repo.js";
import { buildWaSender } from "./wa/wa-sender.js";

export function buildServer(deps: {
  pool: pg.Pool;
  config: Config;
  el?: ElevenLabsClient;
  geo?: GeoResolver;
  interakt?: InteraktClient;
}): FastifyInstance {
  const app = Fastify({ logger: true });
  // Some webhook providers (Plivo CX) send Content-Type: application/json with an
  // EMPTY body and put the data in the query string instead. Default Fastify 400s
  // on the empty body; treat empty as {} so the handler can read req.query.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const s = (body as string)?.trim();
    if (!s) return done(null, {});
    try {
      done(null, JSON.parse(s));
    } catch (err) {
      (err as any).statusCode = 400;
      done(err as Error, undefined);
    }
  });
  // Catch-all: Plivo CX sends an empty body as application/octet-stream (415 by
  // default). Accept any other content type — empty → {}, else best-effort JSON —
  // so webhook handlers can fall back to reading query params.
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    const s = (body as string)?.trim();
    if (!s) return done(null, {});
    try {
      done(null, JSON.parse(s));
    } catch {
      // maybe form-encoded under a different content type
      if (s.includes("=")) {
        try {
          return done(null, Object.fromEntries(new URLSearchParams(s)));
        } catch {
          /* fall through */
        }
      }
      done(null, {});
    }
  });
  // Dispatcher console is a browser SPA on another origin; the API key gates access.
  app.register(cors, { origin: true });
  app.get("/health", async () => ({ status: "ok" }));
  registerPlivoRoutes(app, deps.config.plivoAnswerSipUri);

  const preHandler = requireApiKey(deps.config.apiKey);
  const ownersRepo = new OwnersRepo(deps.pool);
  const loadsRepo = new LoadsRepo(deps.pool);
  const callsRepo = new CallsRepo(deps.pool);
  const el =
    deps.el ??
    (deps.config.voiceProvider === "plivo_native"
      ? buildPlivoNativeClient(deps.config)
      : deps.config.voiceProvider === "plivo"
        ? buildPlivoCxClient(deps.config)
        : buildElevenLabsClient(deps.config));
  const waSessions = new WaSessionsRepo(deps.pool);
  const interakt = deps.interakt ?? (deps.config.waEnabled ? buildInteraktClient(deps.config) : undefined);
  const waSender = interakt
    ? buildWaSender({ interakt, callsRepo, sessions: waSessions, config: deps.config })
    : undefined;
  const orchestrator = new CallOrchestrator({
    pool: deps.pool,
    config: deps.config,
    el,
    ownersRepo,
    loadsRepo,
    callsRepo,
    waSender,
  });

  const quotesRepo = new QuotesRepo(deps.pool);
  const demandRepo = new DemandRepo(deps.pool);
  const geo = deps.geo ?? buildGeoResolver(deps.config);

  registerOwnerRoutes(app, ownersRepo, preHandler);
  registerLoadRoutes(app, loadsRepo, ownersRepo, preHandler);
  registerCallRoutes(app, orchestrator, callsRepo, preHandler);
  registerQuoteRoutes(app, { quotesRepo, orchestrator }, preHandler);
  registerDemandRoutes(app, { demandRepo, loadsRepo, ownersRepo, callsRepo, orchestrator }, preHandler);
  registerWebhookRoutes(app, {
    quotesRepo,
    callsRepo,
    orchestrator,
    demandRepo,
    loadsRepo,
    ownersRepo,
    geo,
    secret: deps.config.webhookSecret,
  });
  return app;
}
