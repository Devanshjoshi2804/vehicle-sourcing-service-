# WhatsApp Connector for Vehicle Sourcing — Design

**Date:** 2026-07-03
**Status:** Approved (brainstorm session)
**Scope:** WhatsApp as a second channel for the existing demand→driver→confirm domino in `new-project/`, via Interakt.

## Decisions (locked with user)

1. **Placement:** inside `new-project` as `src/wa/` (Fastify, same Postgres, same docker-compose). support-service is a pattern reference + credential source only.
2. **Customer intake:** hybrid — one-shot free text parsed by LLM, missing fields asked with buttons/lists.
3. **Driver channel:** per-owner preference `channel: voice | whatsapp | both` (default `voice`). First accept wins across channels (existing race-safe lock).
4. **Customer confirm:** same channel the demand came in on. WhatsApp intake → WhatsApp confirm buttons; voice intake → voice confirm call (unchanged).
5. **Webhook/number:** support-service's Meta/Interakt webhook is being scrapped. Interakt points at `https://<PUBLIC_DOMAIN>/wa/inbound` on new-project — sole consumer of the number.

## Integration approach

WhatsApp offers ride the **existing call pipeline**, not a parallel one:

- `call_attempts.channel` (`voice`|`wa`) — a WA offer is an "attempt" with the same statuses (`QUEUED→IN_PROGRESS→DONE/NO_ANSWER/FAILED/SUPERSEDED`).
- Driver replies feed the existing `recordAvailability` → same `quotes` table, same counter rows on the dashboard, same first-accept-wins lock, same supersede.
- Orchestrator `placeOne` branches on owner channel: voice → provider call (unchanged); whatsapp → `wa-sender.sendOffer()`.
- Watchdog also expires stale WA attempts (own TTL, default 30 min, `WA_REPLY_TTL_MIN`).

Rejected alternatives: parallel `wa_offers` pipeline (duplicates everything); WhatsApp masquerading as a voice provider via `originateCall` (statuses/timeouts don't map honestly).

## Module layout — `src/wa/`

| File | Responsibility |
|---|---|
| `interakt.client.ts` | Outbound sends: text / InteractiveButton / InteractiveList / template. Port of support-service `WhatsAppApiService` (trimmed: no media upload, no WABA template CRUD). Handles Interakt's 200-with-`result:false` as failure. |
| `inbound.ts` | Interakt webhook payload → normalized message. Port of `InteraktInboundService`: JSON interactive replies, title→id resolution against last-sent options, location extraction, media URLs. |
| `wa-sessions.repo.ts` | Postgres session store (replaces Mongo): phone, role, state, draft demand fields, last interactive options, processed message ids. |
| `router.ts` | Inbound phone ∈ `owners` table → driver flow; else customer flow. Dispatches on session state. |
| `customer-flow.ts` | Intake state machine (parse → fill missing → confirm summary → report-demand) + booking confirm/decline handling. |
| `driver-flow.ts` | Offer replies: accept / counter ("My price" → amount capture) / not available. Calls `recordAvailability`. |
| `llm-parse.ts` | Groq structured extraction of a load message → `{from, to, vehicleType, priceInr, pickupDate}` (nullable fields). No key / LLM error → guided flow only. |
| `wa-sender.ts` | Channel operations used by orchestrator + demand routes: `sendOffer`, `sendReoffer`, `sendHold`, `sendConfirm`, `sendUpdate` (filled/cancelled notices). |
| `wa.routes.ts` | `POST /wa/inbound` — HMAC signature guard (`INTERAKT_WEBHOOK_SECRET`), ack 200 immediately, process async. |

## Migration `004_whatsapp.sql`

```sql
ALTER TABLE owners ADD COLUMN channel text NOT NULL DEFAULT 'voice'
  CHECK (channel IN ('voice','whatsapp','both'));
ALTER TABLE call_attempts ADD COLUMN channel text NOT NULL DEFAULT 'voice'
  CHECK (channel IN ('voice','wa'));
ALTER TABLE demand_requests ADD COLUMN channel text NOT NULL DEFAULT 'voice'
  CHECK (channel IN ('voice','whatsapp','console'));

CREATE TABLE wa_sessions (
  phone            text PRIMARY KEY,
  role             text NOT NULL CHECK (role IN ('customer','driver')),
  state            text NOT NULL,
  ctx              jsonb NOT NULL DEFAULT '{}',   -- draft demand / active attempt ids
  last_options     jsonb NOT NULL DEFAULT '[]',   -- [{id,title}] for title→id resolution
  processed_ids    text[] NOT NULL DEFAULT '{}',  -- inbound idempotency (keep last N)
  updated_at       timestamptz NOT NULL DEFAULT now()
);
```

## Customer journey

```
Customer: 16ft mumbai to pune 13000 tomorrow

Bot:  📋 Load summary
      Mumbai → Pune · 16ft · pickup 04 Jul · ₹13,000
      [✅ Confirm]  [✏️ Edit]  [❌ Cancel]
```

Missing fields asked with the right widget:
- **vehicle** → interactive list (Tata Ace · 14ft · 16ft · 17ft · 19ft · 22ft · Container — names aligned with support-service vehicle presets / matcher vehicle types)
- **date** → buttons `[Today] [Tomorrow] [Type a date]`
- **price** → text prompt, digits parsed
- **from/to** → text prompt (geo resolver already normalizes downstream)

`Confirm` → `POST` internal report-demand path with `channel: "whatsapp"` → existing auto-source. Reply: "🔎 Finding you a truck… I'll message you here."
`Edit` → list of fields to change. `Cancel` → session cleared.

**Booking confirm (domino step 4)** — dispatcher clicks Approve driver → demand `channel = whatsapp` → instead of voice call:

```
🚛 Driver found! Mumbai → Pune · 16ft · 04 Jul
Agreed price: ₹14,000 · Driver: Ramesh
[✅ Confirm booking]  [❌ Decline]
```

Confirm → same path as the customer-confirm webhook → BOOKED. Decline → DECLINED (dispatcher one-click re-source unchanged). Sent as session message inside the 24h window, `sourcing_confirm` template outside it.

Demand cancelled/declined → customer gets a courtesy notice.

## Driver journey

Business-initiated → **approved template required** (WhatsApp 24h rule). Offer:

```
🚛 New load — Pinified
Mumbai → Pune · 16ft · pickup 04 Jul
Freight: ₹13,000
[✅ Accept ₹13,000]  [💰 My price]  [❌ Not available]
```

- **Accept** → `recordAvailability(YES, acceptsFixed=true)` → existing lock. Winner: "🎉 Load is yours at ₹13,000." Unanswered WA drivers on that load: "This load has been filled 🙏" (on supersede).
- **My price** → "What's your price for this trip? Reply with the amount (₹)" → digits parsed → `recordAvailability(YES, quotedPriceInr)` → dashboard counter row as with voice. Dispatcher then:
  - **Accept counter** → driver: "🎉 Confirmed at ₹14,000."
  - **Re-offer** → driver gets `[✅ Accept ₹13,500] [❌ No]` (WA send instead of follow-up call).
  - **Hold** → driver gets "₹13,000 is fixed for this load." `[✅ Accept ₹13,000] [❌ No]`.
- **Not available** → `recordAvailability(NO)`.
- No reply → watchdog → `NO_ANSWER` after `WA_REPLY_TTL_MIN` (default 30).
- Unparseable price reply → re-ask once with example; second failure → re-send buttons.

## Templates (one-time prerequisite, created in Interakt)

| Name | Body (variables) | Buttons |
|---|---|---|
| `sourcing_offer` | new load: {{from}} → {{to}}, {{vehicle}}, pickup {{date}}, freight ₹{{price}} | Accept / My price / Not available (quick reply) |
| `sourcing_confirm` | driver found for {{from}} → {{to}} at ₹{{price}}, driver {{name}} | Confirm booking / Decline |
| `sourcing_update` | generic status text {{message}} | — |

Until approved: a WA offer send fails with a clear log and the attempt falls back to a voice call (every owner has a phone number, so nobody is skipped).

## Dashboard touches (minimal)

- 📞/💬 channel badge per row in TheLine (from `call_attempts.channel`).
- Channel badge on demand card (Inbound board).
- Owners screen: channel preference selector.

## Config / env

`INTERAKT_API_KEY`, `INTERAKT_BASE_URL`, `INTERAKT_WEBHOOK_SECRET`, `INTERAKT_DEFAULT_COUNTRY_CODE=+91`, `WA_ENABLED=true|false` (kill switch), `WA_REPLY_TTL_MIN=30`, `GROQ_API_KEY` (already present in the shared .env for the voice agent). Credentials copied from `Support-service.env`.

## Error handling

- Interakt `result:false` in a 200 → send failure → attempt FAILED.
- Webhook acked <3s, processed async (Interakt requirement); processing errors logged, never 5xx'd back.
- Inbound idempotency via `processed_ids`.
- Unknown message mid-flow → re-send current prompt; 3 strikes → "I'll have someone call you" + flag on dashboard.
- LLM unavailable → guided flow.

## Testing

Vitest, existing style (shared test DB, sequential):
- `inbound` fixture parsing: button reply JSON, list reply, title-only echo, free text, counter amount.
- Router: owner phone → driver flow; unknown → customer flow.
- Customer intake: one-shot parse → confirm; partial → fill-in prompts; confirm → demand created with `channel=whatsapp`, auto-source fired.
- Driver accept over WA → lock, supersede of queued voice attempts (cross-channel first-accept-wins).
- Counter → quote row; reoffer/hold sends.
- Booking confirm/decline over WA.
- Watchdog expiry of stale WA attempts.
- Idempotent webhook redelivery.
Interakt client mocked; `scripts/wa-smoke.ts` for a live send against the real number.

## Prerequisites owned by the user

1. Remove support-service webhook from Meta/Interakt; point Interakt at `https://<PUBLIC_DOMAIN>/wa/inbound`.
2. Approve the 3 templates in Interakt (bodies above; exact drafts provided at implementation).
3. Confirm the Interakt key in `Support-service.env` is the production number for sourcing.
