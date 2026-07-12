## Final-review fixes

Applied all 7 findings from the LR/invoice intake final review.

1. **Critical — media messages all shared one dedup key** (`src/wa/wa.routes.ts`):
   the action-dedup key was `t:` (empty, trimmed/lowercased text) for every
   media message, so a driver sending two photos within the 45s window had the
   second silently dropped as a "duplicate". Added a third branch: media →
   `m:${m.mediaUrl}` (still dedupes true BSP redeliveries, which reuse the same
   url, but no longer collapses two distinct photos into one key).
   Test: `tests/wa-routes.test.ts` — "two media messages with different
   media_urls within the dedup window are BOTH processed" posts two signed
   media webhooks (different msg ids + media_urls) from the same driver phone
   inside the window and asserts 2 `driver_docs` rows.

2. **Important — fractional OCR amounts** (`src/wa/vision.ts` `toDoc`):
   `billed_total_inr: 16500.5` passed through unrounded and would later 22P02
   on the integer `billed_inr` column, killing the reply mid-flow. Now
   `Math.round(total)` (kept the `Number.isFinite(total) && total > 0` guard).
   Test: `tests/wa-vision.test.ts` — Gemini returns `16500.5` →
   `doc.billedTotalInr === 16501`.

3. **Important — invoice ownership check** (`src/wa/doc-flow.ts`
   `resolveInvoice`): the OCR'd `lr_number` → lr → load direct match never
   checked whether the LR belonged to the sender, so a driver typing/photographing
   someone else's LR number on an invoice would get that LR's agreed price
   echoed back and the invoice linked to it. Added
   `!lr.ownerId || lr.ownerId === owner.id` to the direct-match gate; a
   foreign-owned LR now falls through to the guess/NO_TRIP path exactly as if
   the ref hadn't resolved. Test: `tests/wa-doc-flow.test.ts` — "invoice
   bearing ANOTHER driver's LR number" sends an invoice from a stranger
   referencing the seeded owner's LR and asserts: no DISPUTED doc gets attached
   to that lr/load, and the stranger gets the NO_TRIP reply (no BOOKED load of
   their own to guess against).

4. **Important — vision client must exist without keys** (`src/server.ts`):
   `docs` deps (and thus the whole vision/LR/invoice pipeline) were only wired
   up when a Gemini/Mistral key was configured, so keyless boxes silently fell
   through to the generic driver greeting on a media message instead of storing
   the doc unprocessed for manual review — contradicting the README/.env.example/
   config comment ("without a vision key, photos are stored unprocessed").
   `vision` is now always built (`deps.vision ?? buildVisionClient(deps.config)`
   — its `no_provider` path makes no network calls) and `docs` is always
   constructed whenever `interakt`/`waSender` exist. No existing test asserted
   the old keyless-greets behavior through `buildServer`, so nothing needed
   updating; full suite stayed green.

5. **Important — typed foreign LRs must not create loads**
   (`src/wa/doc-flow.ts` `resolveLr` / `handleTypedLr`): typed text routed into
   the same foreign-creation branch as the media (OCR'd) path, so typing
   something LR-shaped-but-wrong (e.g. `"16ft"`, a phone number) minted an
   Unknown→Unknown ₹1 DRAFT load. Added an `opts: { allowCreate: boolean }`
   parameter to `resolveLr` — the media path (`handleDriverMedia`) passes
   `true`, the typed path (`handleTypedLr`) passes `false`. A typed foreign
   number now gets `LR <n> not found — our team will check.` and creates no
   doc row (typed path never had media to store). Test:
   `tests/wa-doc-flow.test.ts` — "typed foreign LR number never mints a load"
   asserts the reply text, that no `LR` row is created, and that the total
   `loads` row count is unchanged. The existing media-path foreign-create test
   (#6) is untouched and still green (media passes `allowCreate: true`).

6. **Important — SSRF/timeout hardening** (`src/wa/vision.ts`): the media
   fetch had no scheme restriction (SSRF risk against internal infra via a
   crafted `http://` media url) and no timeout on any outbound call (media
   fetch or either provider call), so a slow/hanging endpoint could hang the
   whole intake pipeline. Added a `mediaUrl.startsWith("https://")` guard
   (else immediate `{ ok: false, reason: "fetch_failed" }`, zero fetch calls)
   and `signal: AbortSignal.timeout(30_000)` on the media fetch and both the
   Gemini and Mistral calls. Test: `tests/wa-vision.test.ts` — `http://` media
   url → `fetch_failed`, `fetch` never called.

7. **Triaged minor — `mintLr` silent catch** (`src/lr/mint.ts`): the outer
   catch swallowed a mint failure with no trace. Added
   `console.error("[lr] mint failed for load", loadId, e)` (matches the
   existing convention in `src/db/migrate.ts` — this file has no injected
   logger). No test required per the review; the existing "mintLr never
   throws" test in `tests/lr-mint.test.ts` now also exercises (and shows in
   stderr) this log line.

### Verification

- `npx vitest run` — 35 files / 184 tests passed (no test needed updating for
  behavior changes beyond the new/adjusted assertions above).
- `npx tsc --noEmit` — clean.
- `web/` was not touched, so no `web` typecheck was run.
