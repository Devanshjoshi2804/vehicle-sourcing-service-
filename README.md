# vehicle-sourcing-service

Standalone service that calls truck/fleet owners over an outbound Hindi IVR to
collect, for a load, each owner's **availability** and their **price** (accept
the fixed price, or counter). Results come back as ranked quotes, and the whole
thing can run as an automated "domino": a customer demand auto-sources drivers →
first driver to accept locks the load → company approves the value → customer is
called to confirm → booked.

Three interchangeable voice backends sit behind one interface (`VOICE_PROVIDER`):
**ElevenLabs ConvAI**, **Plivo CX** (hosted AgentFlow), and our **self-hosted
voice agent on OVH** (Plivo media-stream → Sarvam Hindi STT/TTS → LLM). See
[Architecture](#architecture).

It is independent of the other repo microservices — its own Postgres, its own
owner/load/demand tables. It only reuses credentials.

## Flow

1. Dispatcher creates **owners** (name, phone, vehicle types, lanes).
2. Dispatcher posts a **load** (from, to, vehicle type, pickup date, fixed price).
3. `GET /loads/:id/suggested-owners` — system matches owners by lane + vehicle.
4. `POST /loads/:id/call { ownerIds }` — fans out IVR calls (concurrency-capped).
5. The voice agent calls back `/webhooks/report-availability`; quotes are stored.
6. If an owner wants more than the fixed price, a `fixed_price_followup` call is
   auto-queued ("₹X is fixed, otherwise the booking can't be confirmed").
7. `GET /loads/:id/quotes` — ranked: `available=YES & accepts_fixed=true` first.

## Architecture

Five containers ship as one deployment unit (`docker-compose.yml`), fronted by
**Caddy** (auto-TLS reverse proxy) on three subdomains — one each for the API,
the console, and the voice agent's `wss://` media stream.

```
                         ┌──────────────────────── Caddy (auto-TLS) ────────────────────────┐
                         │   PUBLIC_DOMAIN → app     CONSOLE_DOMAIN → web    VOICE_DOMAIN → voice-agent
                         └───────┬───────────────────────┬─────────────────────────┬─────────┘
                                 │                        │                         │
   Dispatcher ─── HTTPS ───▶  web (React SPA, nginx)      │                         │
                                 │  Bearer $API_KEY        │                         │
                                 ▼                         ▼                         │
                          ┌─────────────── app (Fastify + TS + Zod) ──────────────┐ │
                          │  owners · loads · demand · matcher · quotes · webhooks │ │
                          │  calls/orchestrator  (concurrency-capped fan-out)      │ │
                          │  VOICE_PROVIDER ─┬─ elevenlabs   (ConvAI + Plivo SIP)  │ │
                          │                  ├─ plivo        (Plivo CX AgentFlow)  │ │
                          │                  └─ plivo_native (Plivo Call API) ─────┼─┘
                          └───────┬───────────────────────────────────▲───────────┘
                                  │ SQL                                │ webhooks (quotes / outcomes)
                                  ▼                                    │
                            postgres:16                         voice providers
                                                    ┌───────────────────┴───────────────────┐
                                                    │ ElevenLabs ConvAI  │  Plivo CX AgentFlow │
                                                    │ voice-agent (OVH, this repo) ◀── Plivo media-stream
                                                    └────────────────────────────────────────┘
```

### Components

- **`app`** — the Fastify API. Owns the domain (owners, loads, the demand
  domino), the matcher (lane + vehicle ranking), and the **call orchestrator**
  (concurrency-capped so we never exceed the Plivo trunk's outbound CPS). Voice
  providers are hidden behind a common client interface selected by
  `VOICE_PROVIDER`. Providers report results back over `/webhooks/*`.
- **`postgres`** — its own DB; owner/load/demand/call/quote tables. Migrations in
  `src/db/migrations` (`003_domino.sql` adds the domino state machine).
- **`web`** — the dispatcher console (Vite + React + Tailwind), a static SPA
  served by nginx. API base + key are baked in at build time.
- **`voice-agent`** — the self-hosted OVH agent (below).
- **`caddy`** — TLS termination + routing for all three subdomains.

### Voice providers

One interface, three swappable backends (`VOICE_PROVIDER`):

| Value | Path | Notes |
|---|---|---|
| `elevenlabs` | ElevenLabs ConvAI agent over a Plivo SIP trunk | Original path. Hosted conversation; reports to `/webhooks/report-availability`. |
| `plivo` | Plivo CX **AgentFlow** (hosted, cx.plivo.com) | Backend triggers the flow with call vars; the flow's **Hangup URL** callback carries outcomes to `/webhooks/plivo-hangup` (Plivo's in-call HTTP action sends empty bodies — see note). |
| `plivo_native` | Plivo Call API → our OVH agent | `answer_url` points at the OVH agent's `/answer-outbound`; full control, lowest cost (~₹2/min all-in). |

### The OVH self-hosted voice agent

`voice-agent/` is a **FastAPI** service we run on an OVH box **in India** — this
matters: Plivo terminates the call in India and streams the media to us there, so
the audio never leaves the country (avoids the domestic-anchoring rejection).

**Media path.** Plivo hits `/answer` (inbound customer) or `/answer-outbound`
(outbound driver call) and gets back Plivo **Stream XML** pointing at
`wss://VOICE_DOMAIN/stream`. Plivo then opens a **bidirectional WebSocket** and
streams **8 kHz μ-law** audio both ways. Load context (owner, lane, price, flow)
rides in on the answer-URL query params and is forwarded into the stream URL
(`&` must be XML-escaped or Plivo rejects the doc as "Invalid Answer XML").

**Pipeline** (`pipeline.py`). Per call: VAD-gated turn detection
(`webrtcvad`) → **Sarvam** `saarika` STT (Indian-telephony-tuned) → LLM (Groq /
Mistral / Gemini, keys tried in order, rotate on 429) → **Sarvam** `bulbul:v2`
TTS rendered at 22050 Hz and downsampled (fixes the earlier muffled/robotic
voice), speaking **Devanagari** for correct pronunciation. **Barge-in** lets the
caller interrupt mid-sentence (cancellable speak task + `clearAudio`); disable
with `BARGE_IN=0` if telephony echo makes it self-interrupt.

**Two modes.**
- `intake` (inbound) — a customer describes a load; the agent normalizes it and
  POSTs `/webhooks/report-demand`, which kicks off the domino.
- `offer` (outbound) — the agent pitches a load to a driver at the fixed (or
  re-offered) price and reports availability + quoted price to
  `/webhooks/report-availability`.

Config lives in `voice-agent/config.py` (`SARVAM_*`, `GROQ_*`/`MISTRAL_*`/`GEMINI_*`,
`PUBLIC_WSS_HOST`, `BACKEND_BASE`, `BARGE_IN`).

> **Plivo CX caveat.** Plivo's in-call HTTP Request action sends `Content-Length: 0`
> (empty) bodies — a platform bug. The workaround is to carry the full outcome in
> the flow's **Hangup URL** event callback (`data.object.event_data`), which
> `/webhooks/plivo-hangup` parses. The webhook routes are deliberately tolerant
> (snake/camel keys, query+body, octet-stream) and always return 200.

## Prerequisites

- Node 20+
- Postgres 14+ (local or Docker)
- One voice provider configured:
  - ElevenLabs ConvAI agent + Plivo SIP trunk — see `docs/elevenlabs-agent-setup.md`, **or**
  - Plivo CX AgentFlow, **or**
  - the self-hosted agent (`voice-agent/`, Python 3.11+) with a Sarvam key + an LLM key

## Setup

```bash
cp .env.example .env        # fill in values
npm install

# create databases (example: local docker postgres)
createdb vehicle_sourcing
createdb vehicle_sourcing_test
psql vehicle_sourcing      -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
psql vehicle_sourcing_test -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'

npm run migrate            # apply schema to DATABASE_URL
npm run dev                # start on PORT (default 4200)
```

`MAX_CONCURRENT` must not exceed the Plivo trunk's Outbound CPS (trial = 2).

## Tests

Integration tests need `DATABASE_URL_TEST` (a throwaway Postgres DB). Test files
run sequentially because they share one DB and truncate between files.

```bash
npm test
```

## API (dispatcher routes — `Authorization: Bearer $API_KEY`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/owners` | create owner |
| GET | `/owners` | list owners |
| PATCH | `/owners/:id` | edit owner (vehicleTypes, lanes, active) |
| POST | `/loads` | create load (DRAFT) |
| GET | `/loads/:id` | get load + status |
| GET | `/loads/:id/suggested-owners` | matched owners, ranked |
| POST | `/loads/:id/call` | fire calls to `{ ownerIds[] }` |
| GET | `/loads/:id/calls` | call attempts + statuses |
| GET | `/loads/:id/quotes` | quotes (filter `?available=&acceptsFixed=`) |
| POST | `/loads/:id/owners/:ownerId/followup` | manual fixed-price follow-up |
| POST | `/loads/:id/close` | close load |

Webhook routes (called by ElevenLabs, header `x-webhook-secret: $WEBHOOK_SECRET`):
`POST /webhooks/report-availability`, `POST /webhooks/elevenlabs/post-call`.

A Bruno collection for all of the above lives in `bruno/`.

## Quick curl

```bash
H='-H Authorization:Bearer dev-api-key -H Content-Type:application/json'
curl $H -d '{"name":"Ramesh","phone":"+919999999999","vehicleTypes":["16ft"],"lanes":[{"from":"Mumbai","to":"Pune"}]}' localhost:4200/owners
curl $H -d '{"fromLocation":"Mumbai","toLocation":"Pune","vehicleType":"16ft","pickupDate":"2026-07-01","fixedPriceInr":13000,"createdBy":"disp1"}' localhost:4200/loads
```

## Build / run (prod)

```bash
npm run build   # tsc + copies src/db/migrations into dist
npm start
```
