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
import { registerWaRoutes } from "./wa/wa.routes.js";
import { buildLoadParser } from "./wa/llm-parse.js";
import { LrsRepo } from "./lr/lrs.repo.js";
import { DocsRepo } from "./lr/docs.repo.js";
import { MintDeps } from "./lr/mint.js";
import { registerLrRoutes } from "./lr/lr.routes.js";
import { buildVisionClient, VisionClient } from "./wa/vision.js";
import { ActionDeps } from "./calls/actions.js";
import { registerEmailRoutes } from "./email/email.routes.js";
import { buildMailer, Mailer } from "./email/mailer.js";
import { buildEmailSender } from "./email/email-sender.js";
import { EmailSessionsRepo } from "./email/email-sessions.repo.js";
import { buildEmailRouter } from "./email/router.js";
import { CampaignsRepo } from "./campaigns/campaigns.repo.js";
import { ContactsRepo } from "./campaigns/contacts.repo.js";
import { CampaignAttemptsRepo } from "./campaigns/campaign-attempts.repo.js";
import { CampaignDocsRepo, CampaignEventsRepo } from "./campaigns/campaign-docs.repo.js";
import { registerCampaignRoutes } from "./campaigns/campaigns.routes.js";
import { buildCampaignSender } from "./campaigns/campaign-sender.js";
import { registerCampaignUploadRoutes, uploadUrlFor } from "./campaigns/upload.routes.js";
import { buildIvrDialer, IvrDialer } from "./campaigns/ivr.client.js";
import { registerIvrRoutes } from "./campaigns/ivr.routes.js";

export function buildServer(deps: {
  pool: pg.Pool;
  config: Config;
  el?: ElevenLabsClient;
  geo?: GeoResolver;
  interakt?: InteraktClient;
  vision?: VisionClient;
  mailer?: Mailer;
  ivrDialer?: IvrDialer;
}): FastifyInstance {
  // maxParamLength: the campaign upload link carries its HMAC token as a path
  // param (~180 chars); Fastify's default of 100 would 404 it.
  const app = Fastify({ logger: true, maxParamLength: 500 });
  // Interakt signs /wa/inbound with an HMAC of the RAW body; the JSON content-type
  // parser below only hands handlers the parsed object, so capture the raw bytes
  // for this one route before parsing.
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (req.url === "/wa/inbound") {
      const chunks: Buffer[] = [];
      for await (const c of payload) chunks.push(Buffer.from(c));
      const raw = Buffer.concat(chunks);
      (req as any).rawBody = raw;
      const { Readable } = await import("node:stream");
      return Readable.from(raw);
    }
    return payload;
  });
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
  // Campaign contact upload posts the sheet as raw text; keep it a string so the
  // CSV parser sees it verbatim instead of the catch-all turning it into {}.
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
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
  // Malformed ids reach pg as bad uuid casts (22P02). Map to a clean 400 instead
  // of a 500 that leaks the database error; everything else keeps default handling.
  app.setErrorHandler((err: any, _req, reply) => {
    if (err?.code === "22P02") return reply.code(400).send({ error: "invalid id" });
    app.log.error({ err }, "unhandled route error");
    return reply.code(err?.statusCode && err.statusCode < 500 ? err.statusCode : 500)
      .send({ error: err?.statusCode && err.statusCode < 500 ? err.message : "internal error" });
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
  const mailer =
    deps.mailer ??
    (deps.config.smtpUser && deps.config.smtpPass ? buildMailer(deps.config) : undefined);
  const emailSender = mailer ? buildEmailSender({ mailer, callsRepo, config: deps.config }) : undefined;
  const orchestrator = new CallOrchestrator({
    pool: deps.pool,
    config: deps.config,
    el,
    ownersRepo,
    loadsRepo,
    callsRepo,
    waSender,
    emailSender,
  });

  const quotesRepo = new QuotesRepo(deps.pool);
  const demandRepo = new DemandRepo(deps.pool);
  const geo = deps.geo ?? buildGeoResolver(deps.config);
  const lrsRepo = new LrsRepo(deps.pool);
  const docsRepo = new DocsRepo(deps.pool);
  const mint: MintDeps = { lrsRepo, loadsRepo, demandRepo, ownersRepo, waSender, mailer };
  // Always built — buildVisionClient's no_provider path (no gemini/mistral key)
  // makes no network calls, it just returns ok:false so docs still get stored
  // unprocessed for manual review instead of the pipeline silently not running.
  const vision = deps.vision ?? buildVisionClient(deps.config);
  const availability = { quotesRepo, callsRepo, loadsRepo, demandRepo, orchestrator };

  registerOwnerRoutes(app, ownersRepo, preHandler);
  registerLoadRoutes(app, loadsRepo, ownersRepo, preHandler);
  registerCallRoutes(app, orchestrator, callsRepo, preHandler);
  registerQuoteRoutes(app, { quotesRepo, orchestrator }, preHandler);
  registerDemandRoutes(app, { demandRepo, loadsRepo, ownersRepo, callsRepo, orchestrator, waSender, emailSender, mint }, preHandler);
  registerLrRoutes(app, { lrsRepo, docsRepo, loadsRepo, demandRepo, ownersRepo, waSender, mailer }, preHandler);
  registerWebhookRoutes(app, {
    quotesRepo,
    callsRepo,
    orchestrator,
    demandRepo,
    loadsRepo,
    ownersRepo,
    geo,
    secret: deps.config.webhookSecret,
    mint,
  });

  // Campaign outreach (CSV list → WhatsApp leg → IVR leg → manual queue). Its
  // own tables and repos; it shares the Interakt client, Plivo credentials and
  // this API key with the sourcing product.
  const campaignsRepo = new CampaignsRepo(deps.pool);
  const contactsRepo = new ContactsRepo(deps.pool);
  const campaignAttemptsRepo = new CampaignAttemptsRepo(deps.pool);
  const campaignDocsRepo = new CampaignDocsRepo(deps.pool);
  const campaignEventsRepo = new CampaignEventsRepo(deps.pool);
  const campaignSender = interakt
    ? buildCampaignSender({
        interakt,
        attempts: campaignAttemptsRepo,
        sessions: waSessions,
        config: deps.config,
      })
    : undefined;
  const leg1Deps = campaignSender
    ? {
        contacts: contactsRepo,
        attempts: campaignAttemptsRepo,
        events: campaignEventsRepo,
        sender: campaignSender,
        config: deps.config,
      }
    : undefined;
  // Browser upload page + file read-back. Registered unconditionally: the token
  // is the auth, and without WhatsApp the link can still be handed out manually.
  registerCampaignUploadRoutes(
    app,
    {
      contacts: contactsRepo,
      docs: campaignDocsRepo,
      events: campaignEventsRepo,
      config: deps.config,
      vision,
    },
    preHandler,
  );

  // Leg 2 is a DTMF menu served by this app; the voice agent isn't involved.
  const leg2Deps = {
    pool: deps.pool,
    contacts: contactsRepo,
    attempts: campaignAttemptsRepo,
    events: campaignEventsRepo,
    dialer: deps.ivrDialer ?? buildIvrDialer(deps.config),
    config: deps.config,
  };
  registerIvrRoutes(app, leg2Deps);

  registerCampaignRoutes(
    app,
    {
      pool: deps.pool,
      campaigns: campaignsRepo,
      contacts: contactsRepo,
      events: campaignEventsRepo,
      config: deps.config,
      leg1: leg1Deps,
      leg2: leg2Deps,
    },
    preHandler,
  );

  // Magic-link routes are public (the HMAC token is the auth) and registered
  // unconditionally — a no-op dead end when email sending is off.
  const actions: ActionDeps = { availability, callsRepo, loadsRepo, demandRepo };
  registerEmailRoutes(app, { config: deps.config, actions, mint });

  const capture = { demandRepo, loadsRepo, ownersRepo, callsRepo, orchestrator, geo };

  if (interakt && waSender) {
    const docs = { vision, lrsRepo, docsRepo, loadsRepo, demandRepo, interakt, sessions: waSessions, config: deps.config };
    registerWaRoutes(app, {
      config: deps.config,
      sessions: waSessions,
      ownersRepo,
      campaignContacts: contactsRepo,
      campaign: campaignSender
        ? {
            contacts: contactsRepo,
            attempts: campaignAttemptsRepo,
            docs: campaignDocsRepo,
            events: campaignEventsRepo,
            sender: campaignSender,
            config: deps.config,
            vision,
            uploadUrl: (c) => uploadUrlFor(deps.config, c),
          }
        : undefined,
      driver: { availability, interakt, sessions: waSessions, callsRepo, loadsRepo, config: deps.config, docs },
      customer: { capture, interakt, sessions: waSessions, demandRepo, loadsRepo, availability, callsRepo, parseLoad: buildLoadParser(deps.config), config: deps.config, mint },
    });
  }

  // Email router isn't an HTTP route — main.ts's IMAP source calls
  // emailRouter.handle(msg) directly. Decorated onto the app instance (rather
  // than widening buildServer's return type) so tests can drive it the same
  // way they drive HTTP routes via app.inject.
  if (mailer) {
    const emailSessions = new EmailSessionsRepo(deps.pool);
    const emailDocs = { vision, lrsRepo, docsRepo, loadsRepo, demandRepo, config: deps.config };
    const emailRouter = buildEmailRouter({
      sessions: emailSessions,
      ownersRepo,
      driver: { availability, callsRepo, loadsRepo, config: deps.config, mailer, sessions: emailSessions, docs: emailDocs },
      customer: { capture, mailer, sessions: emailSessions, demandRepo, loadsRepo, parseLoad: buildLoadParser(deps.config), config: deps.config },
      config: deps.config,
    });
    app.decorate("emailRouter", emailRouter);
  }

  return app;
}
