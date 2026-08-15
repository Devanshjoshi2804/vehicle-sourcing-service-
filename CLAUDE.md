# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
docker start vss-pg         # local Postgres on 5433 (5432 is another project's)
npm run dev                 # tsx watch src/main.ts (PORT default 4200)
npm run migrate             # apply src/db/migrations to DATABASE_URL
npm test                    # vitest run (needs DATABASE_URL_TEST)
npx vitest run tests/loads.test.ts            # single file
npx vitest run tests/loads.test.ts -t "DRAFT" # single test by name
npm run build && npm start  # tsc + copy migrations into dist, then node dist/main.js

cd web && npm run dev       # dispatcher SPA (Vite)
cd web && npm run build     # tsc --noEmit + vite build
```

`voice-agent/` is a separate Python FastAPI service (`pip install -r requirements.txt`,
`uvicorn app:app`), deployed to an OVH box in India. `docker-compose.yml` ships
app + postgres + web + voice-agent + caddy as one unit.

## Testing

Integration tests hit a real Postgres (`DATABASE_URL_TEST`), not mocks. `vitest.config.ts`
sets `fileParallelism: false` because every file shares that one DB and
`tests/helpers/db.ts#withTestDb()` TRUNCATEs on setup — **any new table must be added to
that TRUNCATE list** or leftover rows leak between files.

Tests build the real app: `buildServer({ pool, config })` + `app.inject(...)`, with
external clients injected as `deps` overrides (`el`, `interakt`, `vision`, `mailer`,
`geo`) so nothing dials out. `loadConfig(env)` accepts an explicit env object — tests
pass a minimal one instead of touching `process.env`.

## Architecture

Fastify + TypeScript (ESM, `.js` import specifiers) + Zod + raw `pg`. No ORM, no DI
container: `src/server.ts` is the single composition root — it constructs every repo,
client, and orchestrator, then hands them to `register*Routes(app, deps, preHandler)`.
Add a feature by adding a `register…Routes` call there.

Per-domain folders under `src/` follow `*.repo.ts` (SQL) / `*.routes.ts` (HTTP) /
`*.schema.ts` (Zod + types). Business logic that several channels share lives in a
neutral module, not in a route: `quotes/availability.ts` (`recordAvailability` — the
single funnel for a driver outcome from voice, WhatsApp, or email),
`demand/sourcing.ts` (`planSourcing` / `sourceDemand`), `calls/actions.ts`,
`matcher/matcher.ts`, `lr/mint.ts`. **Never re-implement an outcome path per channel** —
route it into the shared function.

### The domino

The core state machine, spanning `demand_requests` → `loads` → `call_attempts` → `quotes`:

- `DemandStatus`: NEW → SOURCING → DRIVER_LOCKED → CUSTOMER_PENDING → BOOKED
  (plus REJECTED / DECLINED / CANCELLED) — documented at `src/demand/demand.repo.ts:4`.
- `LoadStatus`: DRAFT | CALLING | LOCKED | BOOKED | CLOSED (`src/loads/loads.schema.ts:14`).
- `CallStatus`: QUEUED | DIALING | IN_PROGRESS | DONE | NO_ANSWER | FAILED | SUPERSEDED;
  `CallFlow`: `offer` | `fixed_price_followup`; `CallChannel`: `voice` | `wa` | `email`.

First driver to accept locks the load and supersedes the other live attempts. A driver
who counters above the fixed price triggers an auto-queued `fixed_price_followup`.
`calls/watchdog.ts` force-closes attempts stuck live past `CALL_STALE_MINUTES` /
`WA_REPLY_TTL_MIN` / `EMAIL_REPLY_TTL_MIN`, since a terminal webhook is not guaranteed.

### Channels

One owner-facing offer, three transports, all creating a `call_attempt` and all
converging on `recordAvailability`:

- **voice** — `CallOrchestrator` fans out concurrency-capped (`MAX_CONCURRENT` must not
  exceed the Plivo trunk's outbound CPS). Three swappable backends behind one client
  interface, picked by `VOICE_PROVIDER`: `elevenlabs` | `plivo` (CX AgentFlow) |
  `plivo_native` (Plivo Call API → our own `voice-agent/`). Results arrive on `/webhooks/*`.
- **wa** — Interakt BSP; inbound at `POST /wa/inbound`, HMAC-verified against the **raw**
  body (hence the `preParsing` hook in `server.ts`). Requires two pre-approved templates.
- **email** — IMAP poll + SMTP. Not an HTTP route: `buildEmailRouter` is decorated onto
  the app as `app.emailRouter` and driven by `main.ts`'s IMAP source (and by tests
  directly). Replies come as magic links (`GET /e/:action?token=<hmac>`), reply text, or
  attachments.

Owner `channel` is `voice` | `whatsapp` | `both` | `email`. `both` today means
WhatsApp-with-voice-fallback-only-if-the-send-throws — no parallel dial
(`orchestrator.ts#placeOne`).

Driver LR/invoice photos from WhatsApp *and* email share one vision + doc pipeline
(`wa/vision.ts`, `wa/doc-flow.ts`, `lr/`). With no vision key, docs are stored
`unprocessed` rather than dropped.

### Campaign outreach (second product, same app)

`src/campaigns/` is a separate funnel that reuses the channel plumbing but not the
freight domain: CSV upload → leg 1 WhatsApp (`1` = send a document, `2` = not interested)
→ leg 2 DTMF IVR for **only** the leg-1 refusals → leg 3 human queue for the double
refusals. Its own tables (`007_campaigns.sql`) and its own `campaign_attempts` — it does
**not** ride `call_attempts`, whose `load_id`/`owner_id` are NOT NULL FKs into sourcing.

Things worth knowing before editing it:

- `campaign_contacts.stage` is the single source of truth for the funnel; the dashboard is
  a `GROUP BY` over it. But a stage is overwritten as the contact moves, so leg-2 keypad
  outcomes are derived from `campaign_attempts.digit`, not from the stage
  (`src/campaigns/summary.ts`).
- Leg 2's population is set by one `UPDATE … WHERE stage='L1_DECLINED'`, which is what
  makes the BRD's "leg 2 input equals leg 1 eligible output" hold by construction.
- Inbound WhatsApp is shared with the sourcing product. `wa.routes.ts` checks for a **live
  leg-1 campaign attempt first**, so a campaign contact's "1" is not parsed as freight
  intake; the number reverts to driver/customer routing once that attempt closes.
- `/ivr/*` and `/c/u/*` are public and authenticated by HMAC (attempt id / contact token),
  because neither Plivo nor a contact's browser can send the API key.
- The upload link puts a ~180-char token in the path, which is why `server.ts` sets
  `maxParamLength: 500` — Fastify's default of 100 silently 404s it.

## Conventions that bite

- **Migrations are re-run from scratch on every boot and every test run** (`runMigrations`
  applies all `.sql` files in sorted order, no ledger table). Every statement must be
  idempotent: `IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`.
- **Webhook routes are deliberately permissive and always return 200.** Plivo CX sends
  `Content-Length: 0` bodies with data in the query string, sometimes as
  `application/octet-stream` — the content-type parsers in `server.ts` turn empty bodies
  into `{}`. Handlers must accept snake_case *and* camelCase, body *and* query. Don't
  "tighten" these; the tolerance is load-bearing.
- Dispatcher routes are gated by `requireApiKey` (`Authorization: Bearer $API_KEY`);
  webhooks by `x-webhook-secret`; magic links by the HMAC in the token itself.
- `pg` throws `22P02` on a malformed uuid; `server.ts` maps it to a 400. Code that reads
  a uuid off untrusted input (a WhatsApp button payload) should shape-check it first.
- `ponytail:` comments mark deliberate simplifications with a known ceiling and the
  upgrade path. Read the ceiling before "fixing" the code below it.

## Deploy (OVH)

Production is an OVH Public Cloud instance in **Mumbai** (b3-8, Debian 12, instance
`vehicle-sourcing`), `148.113.58.30`, reachable at `https://148-113-58-30.sslip.io`
(Caddy auto-TLS). SSH `debian@148.113.58.30`. It runs `docker compose` from
`~/vehicle-sourcing-service-/` with the real secrets in that box's `.env`.
India residency is not incidental: Plivo terminates the call in India and streams media
to this box, which is what avoids the domestic-anchoring rejection.

`docs/OVH_DEPLOY.md` covers provisioning and `.env`. It does **not** record the two traps
below, which have already cost hours:

- The instance has **two equal-metric default routes** (public `ens3`, private `ens4`).
  When the private one wins there is no egress — `npm install` and in-app Google/Plivo
  calls fail with `EHOSTUNREACH`. Fix is to prefer the public route
  (`ip route ... dev ens3 metric 50`), re-asserted by **`ovh-public-route.timer`** every
  30s — DHCP renewal re-adds the competing route, so a boot-only oneshot is not enough.
  Do not edit netplan on the live box (risks dropping `ens3` and locking out SSH).
- The Dockerfile build stage must keep `npm ci --include=dev` (line 7) — tsc is a
  devDependency; the runtime stage stays `--omit=dev`.

Locally, a Homebrew Postgres on 5432 can shadow the Docker test DB — check which one
`DATABASE_URL_TEST` actually reaches before debugging a "missing table".

## More context

`README.md` has the operator-facing detail (env vars, WhatsApp template variables,
Interakt/Gmail setup, curl examples, the Plivo CX empty-body caveat, LR photo behaviour
table). Design docs and plans live in `docs/superpowers/`; `.superpowers/sdd/` records
the review fixes for the WhatsApp and LR features. `bruno/` is a runnable request
collection for every dispatcher route.
