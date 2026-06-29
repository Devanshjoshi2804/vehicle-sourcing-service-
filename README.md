# vehicle-sourcing-service

Standalone service that calls truck/fleet owners over an outbound Hindi IVR
(ElevenLabs ConvAI over a Plivo SIP trunk) to collect, for a dispatcher-posted
load, each owner's **availability** and whether they accept the dispatcher's
**fixed price**. Results come back as ranked quotes.

It is independent of the other repo microservices — its own Postgres, its own
owner/load tables. It only reuses credentials (ElevenLabs, etc.).

## Flow

1. Dispatcher creates **owners** (name, phone, vehicle types, lanes).
2. Dispatcher posts a **load** (from, to, vehicle type, pickup date, fixed price).
3. `GET /loads/:id/suggested-owners` — system matches owners by lane + vehicle.
4. `POST /loads/:id/call { ownerIds }` — fans out IVR calls (concurrency-capped).
5. The voice agent calls back `/webhooks/report-availability`; quotes are stored.
6. If an owner wants more than the fixed price, a `fixed_price_followup` call is
   auto-queued ("₹X is fixed, otherwise the booking can't be confirmed").
7. `GET /loads/:id/quotes` — ranked: `available=YES & accepts_fixed=true` first.

## Prerequisites

- Node 20+
- Postgres 14+ (local or Docker)
- ElevenLabs ConvAI agent + Plivo SIP trunk — see `docs/elevenlabs-agent-setup.md`

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
