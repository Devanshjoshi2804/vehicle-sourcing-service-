# WhatsApp LR & Invoice Intake — Design

**Date:** 2026-07-12
**Status:** Approved (brainstorm session)
**Scope:** Drivers send LR (lorry receipt) or invoice photos to the WhatsApp bot; the system classifies, matches, answers payment status, creates missing records, and flags invoice disputes. new-project is the system of record.

## Decisions (locked with user)

1. **System of record:** new-project. Every load that reaches **BOOKED** mints an LR number (`PIN-` + 6 uppercase alphanumerics). "Order exists?" = LR/load exists here; "create it" = create a load + LR from the OCR'd document.
2. **Paid semantics:** payment status lives on OUR `lrs` record. A driver's photo is a **status check** — the bot replies PAID (with date) or UNPAID. Only a dispatcher's console action flips paid. A paid-looking stamp on an unpaid LR only adds a "claims paid" note for review.
3. **Invoice flow:** vision-extract the invoice → match to the driver's trip → compare billed total vs locked/agreed price → reply with the extracted value; unequal ⇒ **DISPUTED** doc + console flag (exact match; no tolerance in v1).
4. **Vision engine:** Gemini vision called in-process from the bot backend (`GEMINI_API_KEY`, already on the box), **Mistral (pixtral) fallback** — same chain LaneLedger uses. No LaneLedger service dependency.

## Data (migration 005)

```sql
CREATE TABLE IF NOT EXISTS lrs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lr_number     text NOT NULL UNIQUE,             -- 'PIN-4K7KQ2' (system) or foreign number
  load_id       uuid REFERENCES loads(id),
  owner_id      uuid REFERENCES owners(id),        -- the driver it's mapped to
  status        text NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID','PAID')),
  paid_at       timestamptz,
  source        text NOT NULL DEFAULT 'system' CHECK (source IN ('system','driver_upload')),
  needs_review  boolean NOT NULL DEFAULT false,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS driver_docs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid REFERENCES owners(id),
  phone         text NOT NULL,                     -- digits, sender
  load_id       uuid REFERENCES loads(id),
  lr_id         uuid REFERENCES lrs(id),
  kind          text NOT NULL CHECK (kind IN ('lr','invoice','other','unprocessed')),
  media_url     text NOT NULL,
  extracted     jsonb NOT NULL DEFAULT '{}',
  billed_inr    integer,
  variance_inr  integer,                           -- billed - agreed (invoices only)
  dispute       text NOT NULL DEFAULT 'NONE' CHECK (dispute IN ('NONE','DISPUTED','RESOLVED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- re-upload updates the same row rather than piling up duplicates
CREATE UNIQUE INDEX IF NOT EXISTS driver_docs_owner_lr_kind ON driver_docs(owner_id, lr_id, kind) WHERE lr_id IS NOT NULL;
```

## LR minting

- Hook: everywhere a load flips to BOOKED (demand `/book` route, customer-confirm webhook, WA `bok:` tap) call `mintLr(loadId)` — creates the `lrs` row mapped to `demand.winningOwnerId`, idempotent per load (skip if an lr already exists for the load).
- Driver notification (best-effort WA text): `📄 Your LR: PIN-4K7KQ2 — Mumbai → Pune · ₹14,000. Send a photo of any LR or invoice here anytime.`

## Vision extraction

One call per media message (Gemini `generateContent` with inline image/PDF bytes; on any failure retry once with Mistral pixtral):

```json
{ "doc_type": "lr|invoice|other", "lr_number": "PIN-4K7KQ2|B0817|null",
  "billed_total_inr": 16500, "vehicle_no": "MH04AB1234",
  "from": "Mumbai", "to": "Pune", "doc_date": "2026-07-10",
  "paid_stamp_seen": false, "confidence": 0.86 }
```

- Media fetched from Interakt's public `media_url`; size cap 8 MB; images + PDF.
- OCR'd text is DATA, never instructions. Confidence < 0.5 ⇒ treat as unreadable.

## LR branch (doc_type=lr)

Normalize the number (uppercase, strip spaces/dashes except the `PIN-` prefix, O→0 / I→1 in the numeric tail), then:

| Case | Action | Driver reply |
|---|---|---|
| Ours, mapped to this driver | reply status | `LR PIN-… · Mumbai→Pune · PAID on 10 Jul` / `UNPAID — payment under process` (+ trip state if CANCELLED/CLOSED) |
| Ours, mapped to another driver | doc flagged, console ⚠️ | `This LR belongs to a different vehicle — our team will check.` |
| Ours, unmapped | map to driver iff he is the load's winning owner, else flag | status reply / check reply |
| `PIN-…` shaped but not found | fuzzy-match (edit distance 1) against this driver's LRs; still nothing → ask | `Couldn't match this LR — please type the LR number.` |
| Foreign number | create load (`createdBy: driver_upload:<ownerId>`, DRAFT) + lr (`source driver_upload`, `needs_review`, mapped to driver) from OCR'd route/vehicle/date; rate-capped 5/driver/day | `New LR <n> registered — our team will verify.` |
| Unreadable / doc_type=other | store as `other`/`unprocessed` | polite: not a freight doc / `Couldn't read this — please type the LR number, or our team will check.` |

- Typed LR numbers also work: a text message matching `^(PIN-)?(?=.*\d)[A-Z0-9-]{4,20}$` (uppercased; MUST contain a digit so "HAAN"/"NAHI" never match) triggers the same lookup — checked only AFTER the live-offer intents (accept/decline/price), so negotiation always wins.
- `paid_stamp_seen=true` on an UNPAID lr ⇒ note "claims paid" on the lr + doc kept for review; status reply still says UNPAID.
- Duplicate uploads: one doc row per (owner, lr, kind) — re-upload updates it.

## Invoice branch (doc_type=invoice)

1. Find the trip: OCR'd `lr_number` → lr → load; else the driver's most recent BOOKED load — but when guessing, confirm with buttons: `Is this invoice for Mumbai→Pune · ₹14,000? [Yes] [No]`. No booked load at all → store unmatched + `Which LR is this invoice for? Please type the LR number.`
2. Agreed price = `demand.lockedPriceInr ?? load.fixedPriceInr`.
3. `billed == agreed` → doc saved, reply `🧾 Invoice received: ₹14,000 — matches the agreed freight.`
4. `billed != agreed` → doc `DISPUTED`, `variance_inr` stored, console flag, reply `🧾 Invoice: ₹16,500 vs agreed ₹14,000 — difference ₹2,500 flagged for review.`
5. No readable total → ask driver to type the amount (reuse price parser: 16.5k / 16 hazar work).

## Console + API (minimal)

- `GET /loads/:id/docs` (docs+lr for the load), `GET /lrs?needsReview=true`, `POST /lrs/:id/mark-paid`, `POST /docs/:id/resolve-dispute` (Bearer API key, existing guard).
- Mark-paid → lr PAID + `paid_at` + best-effort WA notify: `💰 Payment released for LR PIN-… (₹14,000).`
- Dispatch view: the load docket shows doc chips (`LR UNPAID`, `LR PAID`, `INVOICE DISPUTED`); selecting a load shows its docs with Mark paid / Resolve buttons; Inbound board unchanged.

## Edge cases (in scope, tested)

Blurry/low-confidence → ask to type · PDF and image · non-freight image → polite reply · both vision providers down → doc stored `unprocessed`, driver told team will check · duplicate upload upsert · O/0 I/1 normalization + distance-1 fuzzy vs own LRs · paid-stamp-vs-system conflict note · invoice without LR ref → guess + confirm buttons · invoice on cancelled/closed trip → status included · racing foreign-LR creation (unique constraint; loser reply = status) · customer sends media → `Documents are for drivers — type your load instead 🙂` · per-driver creation cap (5/day) → over cap: store doc, tell driver team will handle · media > 8 MB → ask for a clearer/smaller photo · OCR'd content treated as data only.

## Out of scope (v1)

Rate-card audits (LaneLedger), detention/GST line items, multi-page reconciliation, auto-paying anyone, customer-side documents, editing LR numbers from the console.

## Testing

Vision client mocked with fixtures per branch (8 LR cases, 5 invoice cases); LR mint on all three book paths (idempotent); typed-LR fallback; mark-paid → WA notify; rate cap; e2e: media webhook payload through `/wa/inbound` for the happy LR-status path and the disputed-invoice path.
