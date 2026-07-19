# Email Channel — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorm session; mailbox provided by user)
**Scope:** Email as a third channel mirroring the WhatsApp connector 1:1 — customers book loads by email, drivers/suppliers send LR/invoice attachments, offers/confirmations/status ride the same demand-domino + doc-flow pipeline.

## Decisions (locked with user)

1. **Inbound:** IMAP polling of the dedicated Gmail mailbox `devanshfreelancingtry@gmail.com` (app password provided; works for both SMTP send and IMAP receive), behind a clean `EmailInbound` interface so a webhook provider (Resend/SES) can swap in later without touching flows.
2. **Outbound:** SMTP via nodemailer — host `smtp.gmail.com`, port 465, secure, same account.
3. **Identity:** `owners.email` column; sender match against an ACTIVE owner = driver/supplier role; no match = customer. Same live-match routing rule as WhatsApp (deactivating an owner immediately makes their email a customer).
4. **Reply UX:** magic links primary (signed HMAC tokens, GET endpoints, tiny branded HTML response) + reply-text parsing fallback (same `parseIntent`/price/LR-number parsers on the first non-quoted lines). Subject tags (`[PIN-XXXXXX]`, `[LOAD-xxxx]`) thread replies to the right record.
5. **Full mirror scope:** customer intake, driver offers (owner channel `email`), booking confirm, LR/invoice attachments through the existing doc-flow, mark-paid + LR-mint notifications.

## Data (migration 006)

```sql
ALTER TABLE owners ADD COLUMN IF NOT EXISTS email text;
CREATE UNIQUE INDEX IF NOT EXISTS owners_email_unique ON owners(lower(email)) WHERE email IS NOT NULL;
-- channel enums gain 'email'
ALTER TABLE owners DROP CONSTRAINT IF EXISTS owners_channel_check;
ALTER TABLE owners ADD CONSTRAINT owners_channel_check CHECK (channel IN ('voice','whatsapp','both','email'));
ALTER TABLE call_attempts DROP CONSTRAINT IF EXISTS call_attempts_channel_check;
ALTER TABLE call_attempts ADD CONSTRAINT call_attempts_channel_check CHECK (channel IN ('voice','wa','email'));
ALTER TABLE demand_requests DROP CONSTRAINT IF EXISTS demand_requests_channel_check;
ALTER TABLE demand_requests ADD CONSTRAINT demand_requests_channel_check CHECK (channel IN ('voice','whatsapp','console','email'));

CREATE TABLE IF NOT EXISTS email_sessions (
  address       text PRIMARY KEY,                  -- lowercased sender address
  role          text NOT NULL CHECK (role IN ('customer','driver')),
  state         text NOT NULL,
  ctx           jsonb NOT NULL DEFAULT '{}',
  processed_ids text[] NOT NULL DEFAULT '{}',      -- Message-ID dedup, keep last 20
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

`driver_docs.phone` stores the email address for email-sourced docs (column is plain text; rename out of scope).

## Modules — `src/email/`

| File | Responsibility |
|---|---|
| `imap-source.ts` | `EmailInbound` interface (`start(onMessage)`, `stop()`) + IMAP implementation: poll UNSEEN every `EMAIL_POLL_SECONDS`, parse via mailparser, mark seen, reconnect loop. Skips auto-replies (`Auto-Submitted` header, `mailer-daemon`/`no-reply`/`postmaster` senders). |
| `mailer.ts` | `Mailer.send(to, subject, text, html?)` via nodemailer; best-effort wrapper used by all notify paths. |
| `inbound.ts` | mailparser output → `EmailInbound` normalized message: `{ from, messageId, subject, text (first non-quoted lines), attachments: [{buffer, mime, filename}], tags: {lr?, load?, attempt?, demand?} }`. Quoted-reply stripping; HTML→text fallback. |
| `tokens.ts` | `signAction({action, id, priceInr?, exp})` / `verifyAction(t)` — HMAC-SHA256 keyed by `WEBHOOK_SECRET`, base64url. |
| `email.routes.ts` | `GET /e/:action?t=<token>` — verify, execute the SAME handlers WhatsApp buttons use (accept/counter-prompt/decline/book/decline-booking), reply tiny HTML. Idempotent (re-click → "already done" page). |
| `customer-flow.ts` | Intake: LLM parse of body → ONE reply email listing all missing fields (email etiquette — not one-question-at-a-time) → summary email with Confirm/Cancel links → `captureDemand(channel:'email')`. Booking confirm email with Confirm/Decline links. |
| `driver-flow.ts` | Sender is owner: attachments → doc-flow (`extractFromBuffer` variant); typed LR numbers/amounts in body; reply-intent (yes/no/price) resolves against subject-tagged attempt else latest live email attempt. |
| `email-sender.ts` | Channel ops: `sendOffer` (attempt channel `email`, conversation id `em_<attemptId>`, Accept/My-price/Not-available links), `sendConfirm`, `sendFilled`, `sendText-equivalent notify`. Registered with the orchestrator the same way waSender is. |
| `router.ts` (in imap-source callback) | owner-by-email match → driver flow; else customer flow; Message-ID dedup via `email_sessions.processed_ids`. |

## Vision from buffers

`vision.ts` gains `extractFromBuffer(buffer, mime)` — same providers/prompt/validation; `extract(mediaUrl)` becomes fetch + delegate. Doc-flow accepts either source; `driver_docs.media_url` stores `email:<messageId>/<filename>` for email docs (no public URL; console "view" hidden for those).

## Offers over email

- Owner channel `email` → orchestrator routes to `emailSender.sendOffer` (same voice-fallback-on-failure semantics as WA).
- Offer email: subject `New load [LOAD-<ticket>] Mumbai → Pune · ₹15,000`, body with route/vehicle/date/price + three links: ✅ Accept · 💰 Counter (link opens tiny form? NO — v1: "reply to this email with your price") · ❌ Not available. Accept/decline are links; counter = reply with amount (parsed).
- Watchdog: email attempts expire after `EMAIL_REPLY_TTL_MIN` (default 120).

## Edge cases (in scope, tested)

Auto-reply/bounce skip · HTML-only bodies · quoted-text stripping (reply intent parses only fresh lines) · signature noise (first 10 non-quoted lines only) · up to 5 attachments/email, each ≤ 8MB (oversize → polite reply) · Message-ID dedup incl. IMAP redelivery · expired/forged/reused tokens (exp check, HMAC verify, idempotent handlers → "already accepted" page) · IMAP disconnect/reconnect (UNSEEN-based, nothing lost) · owner email doubles as booking sender (owner match wins) · unknown subject tags → treated fresh · concurrent accept link + WA tap (locks are race-safe; loser link shows "already filled/already yours" correctly per winner check) · attachments with no body → doc pipeline only.

## Config

`EMAIL_ENABLED` (default true iff IMAP creds present), `IMAP_HOST=imap.gmail.com`, `IMAP_PORT=993`, `IMAP_USER`, `IMAP_PASSWORD`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `EMAIL_POLL_SECONDS=30`, `EMAIL_REPLY_TTL_MIN=120`. Mailbox: `devanshfreelancingtry@gmail.com` (user-provided app password).

## Deps (allowed exception to no-new-deps)

`nodemailer`, `imapflow`, `mailparser` (+ types). Nothing else.

## Console

Owners editor: email field + `email` option in the channel selector. ✉️ badge alongside 📞/💬 on attempts + demands. Nothing else.

## Out of scope (v1)

Webhook inbound providers (interface ready) · HTML template design beyond minimal branding · counter-offer web forms · multiple mailboxes · email for voice-channel owners' notifications.

## Testing

MIME fixture parsing (plain, HTML-only, quoted replies, auto-reply headers, attachments) · token sign/verify/expiry/forgery/idempotent re-click · customer intake e2e (fake inbound source + captured mailer) · offer → accept link → lock → confirm link → BOOKED e2e · attachment → LR status via buffer vision stub · dedup · owner-email routing incl. deactivation flip.
