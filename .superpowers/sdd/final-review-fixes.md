## Final-review fixes

Applied all 9 findings from the WhatsApp connector final review.

1. **Critical — template-tap reply misattribution** (`src/wa/inbound.ts`): in the
   `message_api_clicked` branch, now probes `button_payload.payload.id` →
   `button_payload.id` → `button_payload.payload.text` first; any hit containing
   `:` is used directly as `replyId` (unambiguous even with several concurrent
   offers). Only falls back to title-matching against `lastOptions` when no
   payload id is present, and if the title matches nothing either it now returns
   `kind: "text"` with the raw title — never a raw title as `replyId` (previously
   a downstream `verb:id` parser could misparse an arbitrary title). Left a
   `ponytail:` comment marking the remaining ceiling (title-only echo resolves to
   the driver's *latest* offer).

2. **Critical hardening — driver-flow attempt ownership** (`src/wa/driver-flow.ts`):
   before acting on `acc:`/`ctr:`/`no:` replies, the attempt id is first checked
   against `/^[0-9a-f-]{36}$/i` (pg throws on a bad uuid cast — malformed ids now
   fall through to the generic greeting instead of crashing). For valid ids,
   `callsRepo.getById` loads the attempt and its `phone` (digits-only) must equal
   `m.from`; on missing/mismatched attempt we reply "Sorry, this offer is no
   longer active." and return, instead of acting on someone else's offer.

3. **Important — README template docs** (`README.md` "WhatsApp channel" section):
   rewrote the template table to match `src/wa/wa-sender.ts` exactly —
   `sourcing_offer` (4 body vars: route/vehicle/date/price + 3 buttons),
   `sourcing_confirm` (3 body vars: route/price/driver + 2 buttons),
   `sourcing_update` marked reserved/not required. Added notes that owner
   channel `both` currently behaves as WhatsApp-with-voice-fallback-on-send-failure
   (no parallel voice call) and that concurrent-offer disambiguation depends on
   the BSP echoing the button payload id.

4. **Important — CONFIRM_BOOKING state holes** (`src/wa/customer-flow.ts`): the
   branch now only treats a reply as book/decline when it matches
   `^(bok|dec):[0-9a-f-]{36}$/i`; the `getById` + book/decline action is wrapped
   in try/catch so a DB hiccup doesn't crash-silence the customer. Any unmatched
   reply or free text while in `CONFIRM_BOOKING` now gets a nudge ("Please tap
   ✅ Confirm booking or ❌ Decline above.") and the session is kept — it no
   longer falls through to the intake parser. Added a regression test in
   `tests/wa-customer-flow.test.ts` covering: free text `"yes"` during
   `CONFIRM_BOOKING` → session still `CONFIRM_BOOKING`, nudge sent, demand list
   unchanged.

5. **Important — guard notifyFilled** (`src/quotes/availability.ts`): both call
   sites of `deps.orchestrator?.notifyFilled(...)` are now wrapped in their own
   try/catch so a transient DB/notify error can never abort the lock/supersede
   flow. Call sites/positions unchanged.

6. **Important — approve-driver WA confirm best-effort** (`src/wa/wa-sender.ts`
   `sendConfirm`): the template-fallback send now has its own try/catch nested
   inside the outer catch, so `sendConfirm` never throws. On total failure
   (both session-buttons and template sends fail) the session upsert is skipped
   and the demand simply stays `CUSTOMER_PENDING` for the dispatcher to retry.

7. **Minor — honest driver copy** (`src/wa/driver-flow.ts` AWAIT_PRICE handler):
   now checks `recordAvailability`'s `ok` field; on `ok: false` replies "Sorry —
   something went wrong recording your price. Our team will call you." instead
   of the success "Got it" message.

8. **Minor — duplicate GROQ_API_KEY** (`.env.example`): removed the second
   declaration in the WhatsApp section; kept the original (voice-agent) one and
   added a one-line comment noting the WA free-text parser reuses it.

9. **Minor — wa-domino test hygiene** (`tests/wa-domino.test.ts`): the `el` stub
   now records placed calls into a `placed` array; added
   `expect(placed).toHaveLength(0)` after the approve-driver step to explicitly
   assert the whole domino stayed on WhatsApp with no voice call. Removed the
   leftover stream-of-consciousness planning comment before the guided-flow
   drive, replaced with a one-line note.

### Test output

```
npx tsc --noEmit        → clean, no errors
npx vitest run          → Test Files 29 passed (29) | Tests 84 passed (84)
```

Nothing was left unfixed.
