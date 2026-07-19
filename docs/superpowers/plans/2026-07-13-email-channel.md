# Email Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email as a third channel mirroring WhatsApp 1:1 — customers book by email, drivers get offer emails with magic links, LR/invoice attachments ride the existing doc-flow, all on the same domino/quotes/lock pipeline.

**Architecture:** `src/email/` module: IMAP poller (behind an `EmailInbound` interface) + nodemailer sender + MIME normalizer + HMAC magic-link tokens + email flavors of the customer/driver flows. Shared accept/decline/book cores get extracted from the WA closures into `src/calls/actions.ts` so links, typed replies, and WA buttons execute identical logic. Vision gains `extractFromBuffer` for attachments. Spec: `docs/superpowers/specs/2026-07-13-email-channel-design.md`.

**Tech Stack:** Existing Fastify+TS+Zod+pg+vitest. NEW DEPS (sanctioned): `nodemailer`, `imapflow`, `mailparser` + their `@types`.

## Global Constraints

- ESM `.js` imports; tests via `withTestDb()`; FULL suite `npx vitest run` + `npx tsc --noEmit` before every commit; conventional commits with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; work ONLY in /Users/admin/devansh codes/api-that matters/new-project (own git repo, branch main).
- Channel enums after migration 006: owners `voice|whatsapp|both|email`; call_attempts `voice|wa|email`; demand_requests `voice|whatsapp|console|email`. Email conversation id prefix `em_<attemptId>`.
- Magic-link tokens: HMAC-SHA256 keyed by `config.webhookSecret`, base64url payload `{a: action, id, p?: priceInr, x: expiresEpochSec}`, default expiry 7 days. Routes `GET /e/:action?t=...` where action ∈ `acc|dec|bok|nbk`. Handlers idempotent — a re-click renders "already done" HTML, never errors.
- Auto-reply skip: sender local-part in {mailer-daemon, no-reply, noreply, postmaster} OR `Auto-Submitted` header present (≠ "no").
- Attachment caps: 5 per email, 8 MB each (`config.docMaxBytes`). Reply parsing reads only the first 10 non-quoted lines.
- Mailbox: IMAP `imap.gmail.com:993` / SMTP `smtp.gmail.com:465 secure` — user `devanshfreelancingtry@gmail.com` (env, never hardcoded).
- All existing WA/voice tests must stay green; email disabled (`emailEnabled` false) must leave the server byte-identical in behavior.

---

### Task 1: Deps, migration 006, config

**Files:** Create `src/db/migrations/006_email.sql` (spec SQL verbatim — it is already idempotent). Modify `package.json` (add nodemailer/imapflow/mailparser + @types/nodemailer @types/mailparser as deps — `npm install nodemailer imapflow mailparser && npm install -D @types/nodemailer @types/mailparser`), `src/config.ts`. Test `tests/config.test.ts`, `tests/migrations.test.ts` (run only).

**Produces:** `Config` fields: `emailEnabled: boolean` (true iff IMAP_USER+IMAP_PASSWORD present AND EMAIL_ENABLED not off — same enum-transform pattern as WA_ENABLED), `imapHost` (default `imap.gmail.com`), `imapPort` (993), `imapUser?`, `imapPassword?`, `smtpHost` (default `smtp.gmail.com`), `smtpPort` (465), `smtpSecure` (default true, same bool-transform), `smtpUser?`, `smtpPass?`, `smtpFrom?`, `emailPollSeconds` (30), `emailReplyTtlMin` (120).

Steps: failing config test (mirror the WA_ENABLED test shape incl. `EMAIL_ENABLED=false` kill-switch case) → RED → implement schema+type+mapping → migration file → `npm run migrate` → GREEN full suite + tsc → commit `feat(email): deps, migration 006 (email column/enums/sessions), config`.

---

### Task 2: EmailSessions repo + MIME inbound normalizer

**Files:** Create `src/email/email-sessions.repo.ts` (clone of `wa-sessions.repo.ts` keyed by `address` — same upsert-merge ctx, clear-keeps-row, markProcessed last-20; no lastOptions field), `src/email/inbound.ts`. Test `tests/email-inbound.test.ts`, `tests/email-sessions.test.ts`.

**Produces:**

```ts
// email-sessions.repo.ts
export type EmailSession = { address: string; role: "customer"|"driver"; state: string; ctx: Record<string,unknown> };
export class EmailSessionsRepo { get(address); upsert({address, role, state, ctx?}); clear(address); markProcessed(address, messageId): Promise<boolean> }
// inbound.ts — pure
export type EmailAttachment = { buffer: Buffer; mime: string; filename: string };
export type EmailMsg = {
  from: string;                 // lowercased address only
  messageId: string;
  subject: string;
  text: string;                 // first 10 non-quoted, non-signature lines, trimmed
  attachments: EmailAttachment[];   // capped at 5
  tags: { lr?: string; load?: string; attempt?: string; demand?: string }; // parsed from subject [PIN-…] [LOAD-…] [ATT-…] [DMD-…]
  autoReply: boolean;
};
export function normalizeEmail(parsed: ParsedMail): EmailMsg
```

Quote-strip rule (implement exactly): drop lines starting with `>`, lines matching `/^On .{5,80} wrote:$/`, `/^-{2,}\s*Original Message/i`, `/^From: /` and EVERYTHING after the first such marker; then drop a trailing signature block starting at a line `--` or `Regards,`/`Thanks,`; keep first 10 remaining non-empty lines. Tags regexes: `\[PIN-([A-Z0-9]{6})\]`, `\[LOAD-([a-z0-9-]{4,36})\]`, `\[ATT-([a-f0-9-]{36})\]`, `\[DMD-([a-f0-9-]{36})\]` (case-insensitive on the tag word, id case preserved/uppercased for PIN).

Tests: plain body · HTML-only (uses `parsed.text ?? htmlToText`: mailparser gives `text` for html mails too — fixture proves it via a hand-built ParsedMail-shaped object; do NOT depend on real IMAP) · quoted reply keeps only fresh lines · signature stripped · auto-reply header + no-reply sender flagged · 7 attachments capped to 5 · tags parsed from subject · sessions repo mirror tests (clone the wa-sessions tests incl. clear-keeps-processed_ids).

Commit `feat(email): sessions repo + MIME inbound normalizer`.

---

### Task 3: Shared action cores (refactor) 

**Files:** Create `src/calls/actions.ts`. Modify `src/wa/driver-flow.ts` (accept/counter/decline closures delegate), `src/wa/customer-flow.ts` (bok/dec bodies delegate). Test: existing suites stay green (pure refactor) + one new equivalence test.

**Produces (email routes + flows consume these; WA behavior unchanged):**

```ts
export type ActionDeps = { availability: AvailabilityDeps; callsRepo: CallsRepo; loadsRepo: LoadsRepo; demandRepo: DemandRepo };
export type AcceptOutcome = { kind: "locked" | "already_yours" | "filled"; priceInr: number | null };
export async function acceptAttempt(deps: ActionDeps, attemptId: string, priceInr: number | null): Promise<AcceptOutcome>
  // recordAvailability(YES, acceptsFixed, lockPriceInr, allowUpdate) + attempt DONE + the winner-check
  // (demand.winningOwnerId === attempt owner → already_yours with lockedPriceInr) — lifted VERBATIM from wa driver-flow accept()
export async function counterAttempt(deps: ActionDeps, attemptId: string, priceInr: number): Promise<{ ok: boolean }>
export async function declineAttempt(deps: ActionDeps, attemptId: string): Promise<void>
export async function bookDemand(deps: ActionDeps, demandId: string): Promise<"booked" | "not_pending">   // book + load BOOKED + mintLr caller stays at call sites
export async function declineBooking(deps: ActionDeps, demandId: string): Promise<void>                   // DECLINED + load CLOSED
```

NOTE mint: WA customer-flow currently calls `mintLr` after booking — keep mint at the CALLERS (wa customer-flow + email route), not inside `bookDemand` (mint deps differ). WA flows keep their sessions/say wrappers and just call the cores; replies chosen from the outcome. New test: acceptAttempt on a pre-locked-to-same-owner attempt returns `already_yours` (direct core test). Full suite green proves equivalence. Commit `refactor(calls): shared accept/counter/decline/book action cores`.

---

### Task 4: Tokens + magic-link routes

**Files:** Create `src/email/tokens.ts`, `src/email/email.routes.ts`. Modify `src/server.ts` (register when `emailEnabled` OR always? — register ALWAYS when mailer/email deps constructed; construct email pieces when `config.emailEnabled`; the routes 404 naturally when not registered — tests build server with email test config). Test `tests/email-tokens.test.ts`, `tests/email-routes.test.ts`.

**Produces:**

```ts
// tokens.ts
export type ActionToken = { a: "acc"|"dec"|"bok"|"nbk"; id: string; p?: number; x: number };
export function signAction(secret: string, t: Omit<ActionToken,"x"> & { x?: number }): string   // default x = now + 7d
export function verifyAction(secret: string, token: string): ActionToken | null                  // null on bad sig/expired/malformed
// email.routes.ts
export function registerEmailRoutes(app, deps: { config: Config; actions: ActionDeps; mint?: MintDeps }, /* NO preHandler — links are public, token IS the auth */)
// GET /e/:action?t=… → verify (action must match token.a) → execute core → minimal HTML page:
//   acc: locked → "✅ Load accepted — ₹15,000" · already_yours → "✅ Already yours" · filled → "❌ Load already filled"
//   dec: "👍 Marked not available" · bok: booked → "🎉 Trip booked!" (then mintLr best-effort) · not_pending → "Already handled"
//   nbk: "Booking declined"
//   bad/expired token → 400 page "Link expired — reply to the email instead."
```

Implementation exact:

```ts
const b64u = (b: Buffer) => b.toString("base64url");
export function signAction(secret, t) {
  const payload = { ...t, x: t.x ?? Math.floor(Date.now() / 1000) + 7 * 86400 };
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}
export function verifyAction(secret, token) {
  const [body, mac] = String(token ?? "").split(".");
  if (!body || !mac) return null;
  const expect = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!t?.a || !t?.id || typeof t.x !== "number" || t.x < Date.now() / 1000) return null;
    return t;
  } catch { return null; }
}
```

Tests: sign/verify round-trip · expired → null · tampered mac → null · action mismatch (token a=dec on /e/acc) → 400 · full route e2e via buildServer: seed attempt (channel email) + demand SOURCING → GET /e/acc?t → 200 HTML with ₹, load LOCKED, demand DRIVER_LOCKED · re-click → "Already yours" page, no state change · /e/bok books + mints LR (assert lrs row) · forged token → 400. Commit `feat(email): HMAC magic-link tokens + /e/:action routes`.

---

### Task 5: Mailer + email-sender + orchestrator branch + notify hooks

**Files:** Create `src/email/mailer.ts`, `src/email/email-sender.ts`. Modify `src/calls/orchestrator.ts` (channel routing: owner channel `email` → emailSender.sendOffer, same try/voice-fallback shape as WA), `src/calls/calls.repo.ts` (only if needed: `findLiveEmailByAddress`? NO — email replies resolve via subject tag else latest live email attempt for the OWNER: add `findLiveByOwner(ownerId, channel)`), `src/lr/mint.ts` + `src/lr/lr.routes.ts` (notify: owner channel `email` with email set → mailer instead of waSender), `src/server.ts` wiring, `src/calls/watchdog.ts` (+ email TTL sweep using `emailReplyTtlMin`). Test `tests/email-sender.test.ts`.

**Produces:**

```ts
// mailer.ts
export type Mailer = { send(to: string, subject: string, text: string, html?: string): Promise<boolean> }; // false on failure, never throws
export function buildMailer(config: Config, transportFactory?: () => Transporter): Mailer   // nodemailer.createTransport({host,port,secure,auth}); injectable for tests
// email-sender.ts
export type EmailSender = {
  sendOffer(attempt, load, owner, priceInr, flow): Promise<void>;   // throws on mailer false → orchestrator voice-fallback; sets conv id em_<attemptId>, IN_PROGRESS
  sendConfirm(demand, load, ownerName): Promise<void>;              // bok/nbk links
  sendFilled(email, load): Promise<void>;
  notify(email, subject, text): Promise<void>;                      // LR mint / paid notify
};
export function buildEmailSender(deps: { mailer: Mailer; callsRepo: CallsRepo; config: Config }): EmailSender
```

Offer email exact: subject `New load [ATT-<attemptId>] — <from> → <to> · ₹<price>`; text body route/vehicle/pickup/price + 3 lines: `Accept: <PUBLIC_BASE_URL>/e/acc?t=…` (token p=price) · `Not available: …/e/dec?t=…` · `Counter: reply to this email with your price (e.g. 16500)`. Confirm email: subject `Confirm booking [DMD-<demandId>] — <route>`, links bok/nbk. Watchdog: third sweep `expireStale(emailReplyTtlMin*60_000, "email")`.

Tests (captured fake mailer): email-channel owner → sendOffer email captured with valid acc token (verifyAction round-trips), attempt `email/IN_PROGRESS/em_…` · mailer failure → voice fallback (attempt flips voice, el called) · mint notify prefers WA when channel whatsapp, mailer when channel email+email set · watchdog expires stale email attempts at the email TTL not the wa TTL. Commit `feat(email): mailer + email offer/confirm sender + orchestrator/watchdog/notify wiring`.

---

### Task 6: Vision from buffer + doc-flow buffer entry

**Files:** Modify `src/wa/vision.ts` (`extractFromBuffer(buffer, mime)` — refactor: `extract(mediaUrl)` = fetch (https+size checks) then delegate to shared `extractBytes`), `src/wa/doc-flow.ts` (`handleDriverDocBuffer(deps, ownerLike, replyFn, buffer, mime, sourceRef)` — refactor `handleDriverMedia` so both wrap one core that takes bytes + a reply function + a media reference string; WA passes `interakt.sendText` + media_url, email passes mailer reply + `email:<messageId>/<filename>`). Test: `tests/wa-vision.test.ts` (+2), `tests/wa-doc-flow.test.ts` stays green (refactor) + one buffer-entry test.

Keep ALL WA behavior identical (existing 20+ doc-flow tests are the net). driver_docs media_url for email = the sourceRef. Console DocsPanel: hide "view" link when mediaUrl doesn't start with http (one-line web change, fold into Task 8). Commit `refactor(vision,doc-flow): byte-level entry points for email attachments`.

---

### Task 7: Email customer + driver flows + IMAP source + router

**Files:** Create `src/email/customer-flow.ts`, `src/email/driver-flow.ts`, `src/email/imap-source.ts`, `src/email/router.ts`. Modify `src/server.ts` (construct + expose `emailRouter.handle(msg: EmailMsg)` for tests; buildServer gains optional `mailer?: Mailer`), `src/main.ts` (start IMAP source when `config.emailEnabled`, `source.start(router.handle)`). Test `tests/email-flows.test.ts` (drives `router.handle` directly with EmailMsg fixtures — no real IMAP in tests).

**Produces:**

```ts
// router.ts
export function buildEmailRouter(deps): { handle(msg: EmailMsg): Promise<void> }
// - skip autoReply; markProcessed dedup; owner = ownersRepo.findByEmail(msg.from) (ADD to OwnersRepo: lower(email) match, active only)
// - owner → driver-flow, else customer-flow
// imap-source.ts
export type EmailInbound = { start(onMsg: (m: EmailMsg) => Promise<void>): Promise<void>; stop(): Promise<void> };
export function buildImapSource(config: Config): EmailInbound   // imapflow: connect, poll UNSEEN every emailPollSeconds, mailparser simpleParser, normalizeEmail, mark \Seen, reconnect on error with 30s backoff. NOT covered by unit tests (integration-only) — keep it thin.
```

- customer-flow: body → `parseLoad` → missing fields → ONE email listing all of them (`Reply with the missing details:` bullet list) session state `COLLECTING` (subsequent replies parse-merge until complete) → summary email with Confirm/Cancel links (`cfm` handled via… links use bok-style? NO — booking-confirm links are bok/nbk on the DEMAND; the intake summary Confirm creates the demand: link action NOT needed — keep intake confirm as REPLY-based: "Reply YES to post this load" parsed by intent) — ponytail: intake confirm = reply YES/typed yes; only booking-confirm uses links. On yes → `captureDemand(channel:"email", conversationId: em_<messageId>)` → ack email.
- driver-flow: attachments (≤5) → `handleDriverDocBuffer` each; typed LR number → `handleTypedLr`-equivalent (reuse doc-flow via a replyFn adapter); intent yes/no/price → resolve attempt: subject tag `ATT-` first, else `callsRepo.findLiveByOwner(owner.id, "email")` → shared action cores → reply email (winner-aware copy identical to WA).
- Both reply with helpful walkthrough email when nothing matched (mirror WA help copy, English-first since email).

Tests: customer full journey (partial → collecting → yes → demand channel email SOURCING) · driver accept via typed "yes" with ATT tag · driver counter "16 hazar" recorded · attachment LR status via stubbed vision buffer · autoReply skipped · dedup by messageId · unknown sender + gibberish → walkthrough email. Commit `feat(email): customer/driver flows + router + IMAP source`.

---

### Task 8: Console — owner email field + ✉️ badges + hidden view link

**Files:** Modify `web/src/api/client.ts` (Owner.email?: string|null; channel unions gain "email"; CallAttempt/DemandRequest channel unions), `web/src/views/DriversView.tsx` (email input in add/edit form; channel select gains `✉️ Email`), `web/src/components/TheLine.tsx` + `web/src/views/InboundView.tsx` (badge maps gain email → ✉️), `web/src/components/DocsPanel.tsx` (hide view anchor when `!d.mediaUrl.startsWith("http")`). Backend: `src/owners/owners.schema.ts`/`repo` gain email (create/update/rowTo + `findByEmail`) — if not already done in Task 7, do it here coherently (whichever task lands first implements it; the other verifies). Verify `cd web && npx tsc --noEmit && npm run build` + backend suite. Commit `feat(email): console email field + channel badges`.

---

### Task 9: Env, README, deploy notes, smoke

**Files:** Modify `.env.example` (EMAIL block per spec config list), `README.md` (Architecture gains "Email channel" subsection: IMAP poll → router → same pipeline, magic links, subject tags, mailbox setup steps incl. Gmail app password + IMAP enabled), create `scripts/email-smoke.ts` (send one offer-style email via the mailer to argv[2] and print the acc link for manual click-test). Full suite + build. Commit `docs(email): env, README, smoke script`.

## Deployment notes

Box .env additions: `IMAP_USER=devanshfreelancingtry@gmail.com`, `IMAP_PASSWORD=<app password>`, `SMTP_USER=…`, `SMTP_PASS=…`, `SMTP_FROM="Pinified <devanshfreelancingtry@gmail.com>"`. `docker compose up -d --build app web`. Live smoke: email the mailbox a booking sentence from a personal account; add a test owner with an email + channel email, run a load through, click the Accept link.

## Self-review notes

- Spec coverage: migration/config (T1), sessions+MIME (T2), shared cores (T3), tokens+routes (T4), sender/orchestrator/watchdog/notify (T5), vision buffer + doc-flow (T6), flows+IMAP+router (T7), console (T8), docs (T9). Intake-confirm switched from links to reply-YES (recorded ponytail choice; booking confirm keeps links) — spec's "Confirm/Cancel links" for the SUMMARY relaxed deliberately; note in spec during T9.
- imap-source deliberately integration-only (thin, no unit tests) — flagged so reviewers don't chase coverage there.
- Type consistency: EmailMsg/EmailSender/ActionDeps/AcceptOutcome defined once (T2/T3/T5), consumed by name in T4/T5/T7.
