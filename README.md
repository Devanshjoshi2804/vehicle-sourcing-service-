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

### WhatsApp channel

**Interakt webhook integration** — owners can opt in to offers over WhatsApp
alongside (or instead of) voice calls. Inbound WhatsApp messages land at
`POST /wa/inbound` (verified with `INTERAKT_WEBHOOK_SECRET`), and the driver's
first reply within `WA_REPLY_TTL_MIN` automatically captures their response.

Each offer is created as a **call attempt** with `channel='wa'`, flowing through
the same **quotes/lock/counter pipeline** as voice calls. If a template send
fails (network, message window, etc.), the system gracefully falls back to a
voice call on the same load.

**Two required templates** must be pre-approved in Interakt (see `src/wa/wa-sender.ts`):

| Template | Body variables | Buttons |
|---|---|---|
| `sourcing_offer` | {{1}} route ("Mumbai → Pune"), {{2}} vehicle type, {{3}} pickup date, {{4}} price (number, no ₹) | 3 quick-reply: Accept / My price / Not available — payload ids set per-send via `buttonValues` |
| `sourcing_confirm` | {{1}} route, {{2}} agreed price, {{3}} driver name | 2 quick-reply: Confirm booking / Decline |

`sourcing_update` is **not currently used** by the code (reserved, not required for approval).

WhatsApp's **24-hour message window** applies: offers sent within 24 hours of the
driver's last inbound message can use templates. Outside the window, fallback to
voice.

An owner's channel can be `voice`, `whatsapp`, or `both`. Today `both` behaves like
**WhatsApp-with-voice-fallback-on-send-failure** — there's no parallel voice call, it
only dials if the WhatsApp send itself throws (see `orchestrator.ts` `placeOne`).

Concurrent offers to the same driver phone rely on the BSP echoing the tapped
button's **payload id** back on `message_api_clicked`; if it only sends the button
title, a tap resolves to the driver's latest offer (see `src/wa/inbound.ts`).

**Setup:** Point Interakt webhook at `https://<PUBLIC_DOMAIN>/wa/inbound`, set
`INTERAKT_API_KEY` + `INTERAKT_WEBHOOK_SECRET` in `.env`, submit the two
templates for approval.

### Email channel

**IMAP poll + SMTP send** — owners can receive offers and confirmation links over email. The system polls the mailbox every `EMAIL_POLL_SECONDS`, routes inbound mail by sender email (owner = driver, else customer), and feeds both into the same **demand/doc-flow pipeline** as voice and WhatsApp.

Responses arrive in three forms:
- **Magic links** — `GET /e/:action?token=<hmac>` (ACCEPT, DECLINE, CONFIRM, etc.) expire after `EMAIL_REPLY_TTL_MIN`.
- **Reply-text intent** — e.g., "YES" or "NO" in the email body (recorded as a ponytail choice; subject tags `[PIN-…]`, `[LOAD-…]`, `[ATT-…]`, `[DMD-…]` thread replies to the correct load).
- **Attachments** — LR/invoice photos flow into the same vision-extraction + doc-flow pipeline as WhatsApp.

Outbound notifications for **offers, confirmations, and mark-paid** go to owners configured with email channel. The sender's email address is set via `SMTP_FROM` (e.g., `"Pinified <noreply@example.com>"`).

**Setup:**
1. Enable IMAP in Gmail Settings → Forwarding and POP/IMAP.
2. Create an **app password** (Gmail Account → Security → App passwords) for the email account.
3. Set `.env`:
   ```
   EMAIL_ENABLED=true
   IMAP_USER=<email@gmail.com>
   IMAP_PASSWORD=<app-password>
   SMTP_USER=<email@gmail.com>
   SMTP_PASS=<app-password>
   SMTP_FROM="Pinified <email@gmail.com>"
   ```
4. Add owners with `channel: "email"` (or `"both"` for email + voice fallback).

### Driver documents

Drivers send **LR (lorry receipt) or invoice photos** to the WhatsApp bot for status checks and invoice reconciliation. The system classifies each photo (LR, invoice, or other), matches it to the driver's trip, and returns payment status or flags invoice discrepancies for review.

**LR minting:** Every load that reaches **BOOKED** mints an LR number (`PIN-` + 6 alphanumerics) and notifies the driver. The driver can send a photo anytime; the bot replies with status (PAID on date / UNPAID) or creates a new load if the LR is from a foreign source.

| Photo matches | Bot reply | Dispatcher sees |
|---|---|---|
| Ours, mapped to this driver | Status + trip route | doc chip on load |
| Ours, mapped to another driver | "Belongs to a different vehicle" | doc + ⚠️ console flag |
| Ours, unmapped | Status or "create new LR" flow | doc linked |
| `PIN-…` typed (no photo) | Status lookup from text | — |
| Foreign number | "New LR registered — we'll verify" | load + LR `needs_review`, capped 5/driver/day |
| Unreadable | "Couldn't read this — type the number" | doc stored as `unprocessed` |

**Invoices:** If the photo is an invoice, the system extracts the billed total and compares to the agreed freight. Match → bot confirms receipt; mismatch → doc marked **DISPUTED** and flagged for console review (exact match only in v1; no tolerance).

**Console actions** (Bearer API key):
- `POST /lrs/:id/mark-paid` — flip status to PAID, send WA notify `💰 Payment released for LR PIN-… (₹14,000)`
- `POST /docs/:id/resolve-dispute` — update dispute status after review
- `GET /loads/:id/docs` — view all docs + LR for a load

**Env vars:**
```bash
GEMINI_API_KEY=             # vision extraction (Gemini)
GEMINI_MODEL=gemini-flash-latest
MISTRAL_API_KEY=            # fallback vision (Mistral pixtral, image-only)
MISTRAL_MODEL=pixtral-12b-2409
LR_CREATE_DAILY_CAP=5       # foreign LRs per driver per day
DOC_MAX_BYTES=8388608       # 8 MB media size cap
```

Without a vision key, photos are stored unprocessed for manual review.

### Campaign outreach (WhatsApp → IVR → manual)

A second product on the same stack: upload a customer list and let automation
strip it down before anyone picks up a phone. Same Postgres, same Interakt
number, same Plivo account, same console, same Caddy — no new containers.

```
CSV upload ──▶ LEG 1 WhatsApp ──2──▶ LEG 2 IVR call ──2──▶ LEG 3 Manual queue
               1 = send document      1 = interested        human calls, dispositions
               (doc intake)           (stays automated)     (confirmed / closed lost)
```

Each leg reconciles: `entered = key 1 + key 2 + no answer`, and every count on
the dashboard is a `GROUP BY` over the contact's stage (plus the recorded keypad
digits), so the funnel can never drift from the people it describes.

**Rules the schema enforces.** One record per number per campaign
(`UNIQUE (campaign_id, phone_digits)`); leg 2 dials *exactly* the leg-1 refusals
(one set-based `UPDATE … WHERE stage='L1_DECLINED'`); leg 3 holds only the double
refusals. Invalid upload rows (missing name, bad number, duplicate) are stored
and flagged, never dialed. A leg-1 send failure leaves the contact at `UPLOADED`
so a re-fire retries it — it is never mistaken for a refusal.

**Document intake, two ways.** The contact can send a photo in the WhatsApp chat
(BSP URL → the same vision pipeline as driver LR photos) or use a magic link
(`/c/u/<hmac-token>`) to a small upload page; bytes land in the `uploads` volume.
Either way an unreadable document is still stored for a human to look at.

**Leg 2 is a DTMF menu, not a conversation** — Plivo plays the prompt and posts
the pressed key back to `/ivr/digit`. The self-hosted voice agent is not
involved. `/ivr/*` are public (Plivo cannot send our API key) and authenticated
by an HMAC of the attempt id. One retry, then the contact escalates to a human.

| Method | Path | Purpose |
|---|---|---|
| POST | `/campaigns` | create a campaign |
| POST | `/campaigns/:id/contacts` | upload the list (raw `text/csv` body) |
| POST | `/campaigns/:id/fire-leg1` | WhatsApp blast to everyone still `UPLOADED` |
| POST | `/campaigns/:id/dial-leg2` | enrol the leg-1 refusals and dial them |
| GET | `/campaigns/:id/summary` | funnel + per-leg reconciliation |
| GET | `/campaigns/:id/queue` | leg-3 queue, each row with its history |
| POST | `/campaigns/contacts/:id/disposition` | `CONFIRMED` / `CLOSED_LOST` + note |
| GET | `/campaigns/:id/export?leg=1\|2\|3\|all` | CSV download |

**Setup:** approve an Interakt template with one body variable (the contact name)
and two quick-reply buttons, set `CAMPAIGN_TEMPLATE` to its name, and make sure
`PLIVO_CALLER_ID` is set for the IVR leg.

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
