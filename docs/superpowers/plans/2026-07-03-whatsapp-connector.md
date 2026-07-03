# WhatsApp Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WhatsApp (via Interakt) as a second channel on the sourcing domino: customers post loads by chat, drivers get offer messages with Accept / My-price / No buttons, everything rides the existing call_attempts→quotes→lock pipeline.

**Architecture:** New `src/wa/` module inside the Fastify app. WA offers are `call_attempts` rows with `channel='wa'`; driver replies feed the existing `recordAvailability` (extracted to a shared module); customer intake is an LLM-parse + button/list state machine in Postgres `wa_sessions`; the orchestrator branches per `owners.channel`. Spec: `docs/superpowers/specs/2026-07-03-whatsapp-connector-design.md`.

**Tech Stack:** Fastify + TypeScript + Zod + pg + vitest (all existing). Interakt public API + Groq chat API via global `fetch` (no new dependencies).

## Global Constraints

- Node 20+, ESM, `.js` import suffixes (existing convention).
- Tests use `withTestDb()` from `tests/helpers/db.js`, run sequentially against `DATABASE_URL_TEST`.
- No new npm dependencies — `fetch` and `node:crypto` only.
- Owner channel values: `'voice' | 'whatsapp' | 'both'`. Attempt channel values: `'voice' | 'wa'`. Demand channel values: `'voice' | 'whatsapp' | 'console'`.
- WhatsApp caps: button title ≤ 20 chars, ≤ 3 buttons, list row title ≤ 24 chars, row description ≤ 72, ≤ 10 rows.
- All WA sends go through Interakt (`https://api.interakt.ai/v1/public/message/`); Interakt returns HTTP 200 with `result:false` on logical failure — treat as an error.
- Company name in copy comes from `config.companyName` (default "Pinified"), never hardcoded.
- v1 semantics: owner channel `'whatsapp'` and `'both'` behave identically (WA offer, voice fallback on send failure). `'both'` gains voice-after-TTL later.

---

### Task 1: Migration 004 + config additions

**Files:**
- Create: `src/db/migrations/004_whatsapp.sql`
- Modify: `src/config.ts`
- Test: `tests/migrations.test.ts` (existing — just run it), `tests/config.test.ts`

**Interfaces:**
- Produces: columns `owners.channel`, `call_attempts.channel`, `demand_requests.channel`; table `wa_sessions`; `Config` fields `interaktApiKey?`, `interaktBaseUrl`, `interaktWebhookSecret?`, `interaktCountryCode`, `waEnabled`, `waReplyTtlMin`, `groqApiKey?`, `groqModel`.

- [ ] **Step 1: Write the failing config test** — append to `tests/config.test.ts`:

```ts
it("parses WA/Interakt config with defaults", () => {
  const cfg = loadConfig({
    DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w",
    PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el",
    ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
    INTERAKT_API_KEY: "ik", INTERAKT_WEBHOOK_SECRET: "ws",
  } as NodeJS.ProcessEnv);
  expect(cfg.interaktApiKey).toBe("ik");
  expect(cfg.interaktBaseUrl).toBe("https://api.interakt.ai/v1/public/message/");
  expect(cfg.interaktCountryCode).toBe("+91");
  expect(cfg.waEnabled).toBe(true);
  expect(cfg.waReplyTtlMin).toBe(30);
  expect(cfg.groqModel).toBe("llama-3.3-70b-versatile");
});

it("waEnabled is false without INTERAKT_API_KEY", () => {
  const cfg = loadConfig({
    DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w",
    PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el",
    ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
  } as NodeJS.ProcessEnv);
  expect(cfg.waEnabled).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/config.test.ts` → FAIL (`interaktApiKey` undefined property).

- [ ] **Step 3: Implement.** In `src/config.ts` add to the zod `schema`:

```ts
  // WhatsApp channel via Interakt (BSP). WA is enabled iff an API key is set
  // AND WA_ENABLED isn't explicitly turned off.
  INTERAKT_API_KEY: z.string().optional(),
  INTERAKT_BASE_URL: z.string().default("https://api.interakt.ai/v1/public/message/"),
  INTERAKT_WEBHOOK_SECRET: z.string().optional(),
  INTERAKT_COUNTRY_CODE: z.string().default("+91"),
  WA_ENABLED: z.coerce.boolean().default(true),
  WA_REPLY_TTL_MIN: z.coerce.number().default(30),
  // LLM parse of free-text customer loads (optional — guided flow without it)
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),
```

Add to the `Config` type and `loadConfig` return:

```ts
  interaktApiKey?: string;
  interaktBaseUrl: string;
  interaktWebhookSecret?: string;
  interaktCountryCode: string;
  waEnabled: boolean;
  waReplyTtlMin: number;
  groqApiKey?: string;
  groqModel: string;
```

```ts
    interaktApiKey: p.INTERAKT_API_KEY,
    interaktBaseUrl: p.INTERAKT_BASE_URL,
    interaktWebhookSecret: p.INTERAKT_WEBHOOK_SECRET,
    interaktCountryCode: p.INTERAKT_COUNTRY_CODE,
    waEnabled: Boolean(p.INTERAKT_API_KEY) && p.WA_ENABLED,
    waReplyTtlMin: p.WA_REPLY_TTL_MIN,
    groqApiKey: p.GROQ_API_KEY,
    groqModel: p.GROQ_MODEL,
```

- [ ] **Step 4: Create `src/db/migrations/004_whatsapp.sql`:**

```sql
-- WhatsApp channel: per-owner preference, channel-tagged attempts/demands, and
-- chat session state for the intake/offer conversations.
ALTER TABLE owners ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'voice'
  CHECK (channel IN ('voice','whatsapp','both'));
ALTER TABLE call_attempts ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'voice'
  CHECK (channel IN ('voice','wa'));
ALTER TABLE demand_requests ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'voice'
  CHECK (channel IN ('voice','whatsapp','console'));

CREATE TABLE IF NOT EXISTS wa_sessions (
  phone         text PRIMARY KEY,          -- digits only, e.g. '919888888888'
  role          text NOT NULL CHECK (role IN ('customer','driver')),
  state         text NOT NULL,
  ctx           jsonb NOT NULL DEFAULT '{}',
  last_options  jsonb NOT NULL DEFAULT '[]',
  processed_ids text[] NOT NULL DEFAULT '{}',
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 5: Run migration + tests** — `npm run migrate && npx vitest run tests/migrations.test.ts tests/config.test.ts` → PASS. (The test helper applies migrations to the test DB.)

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(wa): migration 004 (channel columns + wa_sessions) and Interakt/Groq config"`

---

### Task 2: Channel plumbed through owners + calls repos/routes

**Files:**
- Modify: `src/owners/owners.schema.ts`, `src/owners/owners.repo.ts`, `src/owners/owners.routes.ts`, `src/calls/calls.repo.ts`
- Test: `tests/owners.test.ts`, `tests/calls-repo.test.ts`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `Owner.channel: "voice"|"whatsapp"|"both"`; `OwnersRepo.findByPhoneDigits(digits: string): Promise<Owner|null>`; `NewCallAttempt.channel?: "voice"|"wa"` and `CallAttempt.channel`; `CallsRepo.expireStale(olderThanMs, channel)` (channel now required); `CallsRepo.listLivePeersByLoad(loadId, exceptOwnerId)` for filled-notices.

- [ ] **Step 1: Failing tests.** Append to `tests/owners.test.ts`:

```ts
it("owner channel defaults to voice, is patchable, and findByPhoneDigits matches", async () => {
  const { pool } = await withTestDb();
  const repo = new OwnersRepo(pool);
  const o = await repo.createOwner({ name: "R", phone: "+919111111199", vehicleTypes: ["16ft"], lanes: [] });
  expect(o.channel).toBe("voice");
  const upd = await repo.updateOwner(o.id, { channel: "whatsapp" } as any);
  expect(upd!.channel).toBe("whatsapp");
  const found = await repo.findByPhoneDigits("919111111199");
  expect(found!.id).toBe(o.id);
  expect(await repo.findByPhoneDigits("910000000000")).toBeNull();
});
```

Append to `tests/calls-repo.test.ts`:

```ts
it("wa attempts carry channel and expire on their own TTL", async () => {
  const { pool } = await withTestDb();
  const repo = new CallsRepo(pool);
  const owners = new OwnersRepo(pool);
  const loads = new LoadsRepo(pool);
  const o = await owners.createOwner({ name: "W", phone: "+919111111188", vehicleTypes: ["16ft"], lanes: [] });
  const l = await loads.createLoad({ fromLocation: "A", toLocation: "B", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 1, createdBy: "t" });
  const a = await repo.create({ loadId: l.id, ownerId: o.id, phone: o.phone, flow: "offer", channel: "wa" });
  expect(a.channel).toBe("wa");
  await repo.setStatus(a.id, "IN_PROGRESS");
  await pool.query(`UPDATE call_attempts SET created_at = now() - interval '31 minutes' WHERE id=$1`, [a.id]);
  expect(await repo.expireStale(60 * 60_000, "wa")).toEqual([]);       // 60min TTL: not stale yet
  expect(await repo.expireStale(30 * 60_000, "voice")).toEqual([]);    // wrong channel: untouched
  expect(await repo.expireStale(30 * 60_000, "wa")).toEqual([a.id]);   // 30min TTL: expired
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run tests/owners.test.ts tests/calls-repo.test.ts`

- [ ] **Step 3: Implement.**

`src/owners/owners.schema.ts` — add to the `Owner` type and the zod input schema:

```ts
export type OwnerChannel = "voice" | "whatsapp" | "both";
// in Owner type:
  channel: OwnerChannel;
// in OwnerInput zod object (optional, default voice):
  channel: z.enum(["voice", "whatsapp", "both"]).default("voice"),
```

`src/owners/owners.repo.ts`:

```ts
// rowToOwner: add
    channel: r.channel,
// createOwner INSERT:
      `INSERT INTO owners(name, phone, vehicle_types, lanes, channel)
       VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *`,
      [i.name, i.phone, i.vehicleTypes, JSON.stringify(i.lanes), i.channel ?? "voice"],
// updateOwner SET: add   channel = COALESCE($6, channel)
//   and param: patch.channel ?? null
// new method:
  // WA webhooks identify senders by bare digits ('919888888888'); owner phones
  // are stored with '+'. Match on the digit form.
  async findByPhoneDigits(digits: string): Promise<Owner | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM owners WHERE regexp_replace(phone, '\\D', '', 'g') = $1 AND active = true LIMIT 1`,
      [digits],
    );
    return rows[0] ? rowToOwner(rows[0]) : null;
  }
```

`src/owners/owners.routes.ts` — allow `channel` in the PATCH body schema (same enum, optional).

`src/calls/calls.repo.ts`:

```ts
export type CallChannel = "voice" | "wa";
// NewCallAttempt: add   channel?: CallChannel;
// CallAttempt:    add   channel: CallChannel;
// rowToCall:      add   channel: r.channel,
// create() INSERT:
      `INSERT INTO call_attempts(load_id,owner_id,phone,flow,attempt_no,status,channel)
       VALUES ($1,$2,$3,$4,$5,'QUEUED',$6) RETURNING *`,
      [a.loadId, a.ownerId, a.phone, a.flow, a.attemptNo ?? 1, a.channel ?? "voice"],
// expireStale — channel-aware (watchdog calls it once per channel):
  async expireStale(olderThanMs: number, channel: CallChannel = "voice"): Promise<string[]> {
    const { rows } = await this.pool.query(
      `UPDATE call_attempts SET status='NO_ANSWER', ended_at=now()
       WHERE status = ANY($1) AND channel = $3
         AND created_at < now() - ($2::numeric * interval '1 millisecond')
       RETURNING id`,
      [["DIALING", "IN_PROGRESS"], olderThanMs, channel],
    );
    return rows.map((r) => r.id);
  }
// new: WA drivers still waiting on a load when someone else locks it — we tell
// them the load is filled. Query BEFORE supersedePending flips their status.
  async listLivePeersByLoad(loadId: string, exceptOwnerId: string): Promise<CallAttempt[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM call_attempts WHERE load_id=$1 AND owner_id<>$2 AND status = ANY($3)`,
      [loadId, exceptOwnerId, LIVE_STATUSES],
    );
    return rows.map(rowToCall);
  }
```

`src/calls/watchdog.ts` — tick expires both channels:

```ts
// inside tick():
      const expired = await callsRepo.expireStale(staleMs, "voice");
      const expiredWa = await callsRepo.expireStale(opts.waStaleMinutes * 60_000, "wa");
      const n = expired.length + expiredWa.length;
      if (n) opts.log?.(`watchdog: closed ${n} stale attempt(s)`);
// opts gains: waStaleMinutes: number
```

Update the `startCallWatchdog` call in `src/main.ts`: `{ staleMinutes: cfg.callStaleMinutes, waStaleMinutes: cfg.waReplyTtlMin, log: ... }`.

- [ ] **Step 4: Run FULL suite** (`npx vitest run`) — existing `expireStale` test still passes (default channel `"voice"`). Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(wa): channel on owners/call_attempts, phone-digit owner lookup, channel-aware watchdog"`

---

### Task 3: Extract recordAvailability into a shared module

Pure refactor — the WA driver flow (Task 8) needs the same accept/counter/lock logic the webhooks use, and it currently lives as a closure inside `registerWebhookRoutes`.

**Files:**
- Create: `src/quotes/availability.ts`
- Modify: `src/webhooks/webhooks.routes.ts`
- Test: existing `tests/webhooks.test.ts`, `tests/side-a-flow.test.ts` (no new tests — behavior unchanged)

**Interfaces:**
- Produces:

```ts
export type AvailabilityDeps = {
  quotesRepo: QuotesRepo; callsRepo: CallsRepo; loadsRepo: LoadsRepo; demandRepo: DemandRepo;
};
export type AvailabilityResult = {
  ok: boolean; reason?: string; created?: boolean;
  locked?: boolean; loadId?: string; ownerId?: string;
};
export async function recordAvailability(
  deps: AvailabilityDeps,
  f: { cid?: string | null; available?: string | null; acceptsFixed?: boolean | null;
       quotedPriceInr?: number | null; vehicleType?: string | null; note?: string | null;
       lockPriceInr?: number | null },
): Promise<AvailabilityResult>
```

- [ ] **Step 1: Create `src/quotes/availability.ts`** — move the closure body verbatim from `src/webhooks/webhooks.routes.ts:100-160` with three deltas: (a) `deps.` references resolve against the new `AvailabilityDeps`; (b) the lock price becomes `f.lockPriceInr ?? load?.fixedPriceInr ?? quotedPriceInr ?? 0` (existing behavior when `lockPriceInr` is absent; lets a WA accept-of-reoffer lock at the re-offered price); (c) return `{ ok: true, created, locked, loadId: call.loadId, ownerId: call.ownerId }` where `locked` is true when the lock/status-flip branch ran (either the demand `lockDriver` succeeded or the side-B `load.status === "CALLING"` flip happened).

- [ ] **Step 2: Rewire `webhooks.routes.ts`** — delete the inline closure; `import { recordAvailability } from "../quotes/availability.js";` and call it as `recordAvailability({ quotesRepo: deps.quotesRepo, callsRepo: deps.callsRepo, loadsRepo: deps.loadsRepo, demandRepo: deps.demandRepo }, {...})` at both call sites (report-availability, plivo-hangup).

- [ ] **Step 3: Run FULL suite** — `npx vitest run` → PASS (pure refactor; any failure means the move changed behavior — fix before proceeding).

- [ ] **Step 4: Commit** — `git commit -am "refactor: extract recordAvailability to src/quotes/availability.ts (+lockPriceInr, lock outcome in result)"`

---

### Task 4: Interakt client

**Files:**
- Create: `src/wa/interakt.client.ts`
- Test: `tests/wa-interakt.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1).
- Produces:

```ts
export type WaOption = { id: string; title: string };
export type InteraktClient = {
  sendText(to: string, text: string): Promise<void>;
  sendButtons(to: string, body: string, buttons: WaOption[], header?: string): Promise<WaOption[]>; // returns trimmed options for session storage
  sendList(to: string, body: string, buttonLabel: string,
           rows: Array<{ id: string; title: string; description?: string }>, header?: string): Promise<WaOption[]>;
  sendTemplate(to: string, name: string, bodyValues: string[], buttonValues?: Record<string, string[]>): Promise<void>;
};
export function buildInteraktClient(config: Config, fetchImpl?: typeof fetch): InteraktClient
```

`to` is digits (`"919888888888"`). All methods throw on HTTP error or `result:false`.

- [ ] **Step 1: Write failing tests** — `tests/wa-interakt.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildInteraktClient } from "../src/wa/interakt.client.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({
  DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w", PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
  INTERAKT_API_KEY: "ik-base64",
} as NodeJS.ProcessEnv);

function fakeFetch(body: any = { result: true }, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("interakt client", () => {
  it("splits phone into countryCode + 10 digits and sends Basic auth", async () => {
    const f = fakeFetch();
    await buildInteraktClient(config, f).sendText("919888888888", "hello");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.interakt.ai/v1/public/message/");
    expect(init.headers.Authorization).toBe("Basic ik-base64");
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ countryCode: "+91", phoneNumber: "9888888888", type: "Text", data: { message: "hello" } });
  });

  it("trims buttons to 3 × 20 chars and returns the trimmed options", async () => {
    const f = fakeFetch();
    const opts = await buildInteraktClient(config, f).sendButtons("919888888888", "pick", [
      { id: "a", title: "This title is way too long for WhatsApp" },
      { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" },
    ]);
    expect(opts).toHaveLength(3);
    expect(opts[0].title.length).toBe(20);
    const sent = JSON.parse((f as any).mock.calls[0][1].body);
    expect(sent.type).toBe("InteractiveButton");
    expect(sent.data.message.action.buttons).toHaveLength(3);
  });

  it("throws on result:false", async () => {
    const f = fakeFetch({ result: false, message: "template not found" });
    await expect(buildInteraktClient(config, f).sendText("919888888888", "x")).rejects.toThrow(/template not found/);
  });

  it("throws on http 500", async () => {
    const f = fakeFetch({}, 500);
    await expect(buildInteraktClient(config, f).sendText("919888888888", "x")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run tests/wa-interakt.test.ts`

- [ ] **Step 3: Implement `src/wa/interakt.client.ts`** (port of support-service `WhatsAppApiService`, fetch-based, trimmed to what sourcing needs):

```ts
import { Config } from "../config.js";

export type WaOption = { id: string; title: string };
export type InteraktClient = {
  sendText(to: string, text: string): Promise<void>;
  sendButtons(to: string, body: string, buttons: WaOption[], header?: string): Promise<WaOption[]>;
  sendList(to: string, body: string, buttonLabel: string,
           rows: Array<{ id: string; title: string; description?: string }>, header?: string): Promise<WaOption[]>;
  sendTemplate(to: string, name: string, bodyValues: string[], buttonValues?: Record<string, string[]>): Promise<void>;
};

// Interakt wants countryCode + a 10-digit local number, split from the wa_id digits.
function splitPhone(to: string, defaultCc: string) {
  const digits = (to || "").replace(/\D/g, "");
  const local = digits.slice(-10);
  const isd = digits.slice(0, -10);
  return { countryCode: isd ? `+${isd}` : defaultCc, phoneNumber: local };
}

export function buildInteraktClient(config: Config, fetchImpl: typeof fetch = fetch): InteraktClient {
  if (!config.interaktApiKey) throw new Error("INTERAKT_API_KEY not set");

  async function post(to: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetchImpl(config.interaktBaseUrl, {
      method: "POST",
      headers: { Authorization: `Basic ${config.interaktApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...splitPhone(to, config.interaktCountryCode), ...body }),
    });
    const data = await res.json().catch(() => ({}));
    // Interakt reports logical failures as 200 + result:false.
    if (!res.ok || (data as any)?.result === false) {
      throw new Error(`interakt send failed (${res.status}): ${(data as any)?.message ?? "unknown"}`);
    }
  }

  return {
    async sendText(to, text) {
      await post(to, { type: "Text", data: { message: text } });
    },

    async sendButtons(to, body, buttons, header) {
      const trimmed = buttons.slice(0, 3).map((b) => ({ id: b.id, title: b.title.slice(0, 20) }));
      const message: Record<string, unknown> = {
        type: "button",
        body: { text: body },
        action: { buttons: trimmed.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      };
      if (header) message.header = { type: "text", text: header.slice(0, 60) };
      await post(to, { type: "InteractiveButton", data: { message } });
      return trimmed;
    },

    async sendList(to, body, buttonLabel, rows, header) {
      const trimmedRows = rows.slice(0, 10).map((r) => ({
        id: r.id.slice(0, 200),
        title: r.title.slice(0, 24),
        ...(r.description ? { description: r.description.slice(0, 72) } : {}),
      }));
      const message: Record<string, unknown> = {
        type: "list",
        body: { text: body },
        action: { button: buttonLabel.slice(0, 20), sections: [{ rows: trimmedRows }] },
      };
      if (header) message.header = { type: "text", text: header.slice(0, 60) };
      await post(to, { type: "InteractiveList", data: { message } });
      return trimmedRows.map((r) => ({ id: r.id, title: r.title }));
    },

    // Business-initiated sends (driver offers, out-of-window confirms) must use a
    // pre-approved template. bodyValues fill {{1}}..{{n}}; buttonValues carries
    // quick-reply payloads keyed by button index ("0": ["acc:..."]).
    async sendTemplate(to, name, bodyValues, buttonValues) {
      await post(to, {
        type: "Template",
        template: { name, languageCode: "en", bodyValues, ...(buttonValues ? { buttonValues } : {}) },
      });
    },
  };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/wa-interakt.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(wa): Interakt send client (text/buttons/list/template, fetch-based)"`

---

### Task 5: Inbound normalizer + sessions repo

**Files:**
- Create: `src/wa/inbound.ts`, `src/wa/wa-sessions.repo.ts`
- Test: `tests/wa-inbound.test.ts`, `tests/wa-sessions.test.ts`

**Interfaces:**
- Produces:

```ts
// inbound.ts — pure function, no I/O
export type WaInbound = {
  from: string;                       // digits
  msgId: string;
  kind: "reply" | "text";
  replyId?: string; replyTitle?: string;   // kind=reply
  text?: string;                           // kind=text
  contactName: string;
};
export function parseInbound(payload: unknown, lastOptions: WaOption[]): WaInbound | null

// wa-sessions.repo.ts
export type WaSession = {
  phone: string; role: "customer" | "driver"; state: string;
  ctx: Record<string, unknown>; lastOptions: WaOption[];
};
export class WaSessionsRepo {
  constructor(pool: pg.Pool)
  get(phone: string): Promise<WaSession | null>
  upsert(s: { phone: string; role: "customer" | "driver"; state: string; ctx?: Record<string, unknown>; lastOptions?: WaOption[] }): Promise<WaSession>
  clear(phone: string): Promise<void>
  // returns false when msgId was already processed (idempotency; keeps last 20 ids)
  markProcessed(phone: string, msgId: string): Promise<boolean>
}
```

- [ ] **Step 1: Failing tests.** `tests/wa-inbound.test.ts` (fixtures mirror the real Interakt shapes handled in support-service `interakt-inbound.service.ts`):

```ts
import { describe, it, expect } from "vitest";
import { parseInbound } from "../src/wa/inbound.js";

const base = (message: any, extra: any = {}) => ({
  type: "message_received",
  timestamp: "2026-07-03T10:00:00Z",
  data: {
    customer: { channel_phone_number: "+91 98888 88888", traits: { name: "Ramesh" } },
    message: { id: "m1", message_content_type: "Text", message, ...extra },
  },
});

describe("parseInbound", () => {
  it("ignores non-message events", () => {
    expect(parseInbound({ type: "message_delivered" }, [])).toBeNull();
  });

  it("parses interactive reply JSON in the message field (id wins)", () => {
    const r = parseInbound(base(JSON.stringify({ type: "button_reply", button_reply: { id: "acc:a1:13000", title: "✅ Accept ₹13,000" } })), []);
    expect(r).toMatchObject({ from: "919888888888", kind: "reply", replyId: "acc:a1:13000", msgId: "m1", contactName: "Ramesh" });
  });

  it("parses list_reply JSON", () => {
    const r = parseInbound(base(JSON.stringify({ type: "list_reply", list_reply: { id: "veh:16ft", title: "16ft" } })), []);
    expect(r).toMatchObject({ kind: "reply", replyId: "veh:16ft" });
  });

  it("resolves a title-only echo against lastOptions (emoji-insensitive)", () => {
    const r = parseInbound(base("Accept ₹13,000"), [{ id: "acc:a1:13000", title: "✅ Accept ₹13,000" }]);
    expect(r).toMatchObject({ kind: "reply", replyId: "acc:a1:13000" });
  });

  it("falls through to free text when nothing matches", () => {
    const r = parseInbound(base("16ft mumbai to pune 13000"), [{ id: "x", title: "Confirm" }]);
    expect(r).toMatchObject({ kind: "text", text: "16ft mumbai to pune 13000" });
  });
});
```

`tests/wa-sessions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { WaSessionsRepo } from "../src/wa/wa-sessions.repo.js";

describe("wa sessions", () => {
  it("upserts, reads, clears", async () => {
    const { pool } = await withTestDb();
    const repo = new WaSessionsRepo(pool);
    expect(await repo.get("911")).toBeNull();
    await repo.upsert({ phone: "911", role: "customer", state: "ASK_PRICE", ctx: { fromText: "Mumbai" } });
    let s = await repo.get("911");
    expect(s).toMatchObject({ role: "customer", state: "ASK_PRICE", ctx: { fromText: "Mumbai" } });
    await repo.upsert({ phone: "911", role: "customer", state: "CONFIRM", lastOptions: [{ id: "ok", title: "Confirm" }] });
    s = await repo.get("911");
    expect(s!.state).toBe("CONFIRM");
    expect(s!.ctx).toMatchObject({ fromText: "Mumbai" }); // ctx merges, not replaced
    expect(s!.lastOptions[0].id).toBe("ok");
    await repo.clear("911");
    expect(await repo.get("911")).toBeNull();
  });

  it("markProcessed dedupes message ids", async () => {
    const { pool } = await withTestDb();
    const repo = new WaSessionsRepo(pool);
    await repo.upsert({ phone: "912", role: "driver", state: "IDLE" });
    expect(await repo.markProcessed("912", "m1")).toBe(true);
    expect(await repo.markProcessed("912", "m1")).toBe(false);
    expect(await repo.markProcessed("912", "m2")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement `src/wa/inbound.ts`:**

```ts
import { WaOption } from "./interakt.client.js";

export type WaInbound = {
  from: string;
  msgId: string;
  kind: "reply" | "text";
  replyId?: string;
  replyTitle?: string;
  text?: string;
  contactName: string;
};

const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Interakt inbound → one normalized shape. Three ways a tap reaches us:
// (1) `message` is a JSON string {"type":"button_reply",...} carrying OUR id;
// (2) template button clicks arrive as message_api_clicked with button_text;
// (3) session replies sometimes echo just the tapped TITLE — resolve it against
//     the options we last sent (emoji/punctuation-insensitive), else free text.
export function parseInbound(payload: any, lastOptions: WaOption[]): WaInbound | null {
  const type = payload?.type;
  if (type !== "message_received" && type !== "message_api_clicked") return null;

  const customer = payload?.data?.customer ?? {};
  const msg = payload?.data?.message ?? {};
  const from: string = String(customer.channel_phone_number ?? "").replace(/\D/g, "");
  if (!from) return null;
  const msgId: string = msg.id || `${from}-${payload?.timestamp ?? ""}`;
  const contactName: string = customer?.traits?.name || "there";
  const base = { from, msgId, contactName };

  if (type === "message_api_clicked") {
    const title: string = msg.button_text || msg.button_payload?.payload?.text || "";
    const hit = lastOptions.find((o) => norm(o.title) === norm(title));
    return { ...base, kind: "reply", replyId: hit?.id ?? title, replyTitle: title };
  }

  const raw = typeof msg.message === "string" ? msg.message.trim() : "";
  if (raw.startsWith("{") && raw.includes("_reply")) {
    try {
      const parsed = JSON.parse(raw);
      const inner = parsed.list_reply || parsed.button_reply || parsed.reply;
      if (inner && (inner.id || inner.title)) {
        return { ...base, kind: "reply", replyId: String(inner.id ?? inner.title), replyTitle: String(inner.title ?? inner.id) };
      }
    } catch { /* not a JSON reply */ }
  }

  const needle = norm(raw);
  if (needle) {
    const hit = lastOptions.find((o) => norm(o.title) === needle);
    if (hit) return { ...base, kind: "reply", replyId: hit.id, replyTitle: raw };
  }
  return { ...base, kind: "text", text: raw };
}
```

- [ ] **Step 4: Implement `src/wa/wa-sessions.repo.ts`:**

```ts
import pg from "pg";
import { WaOption } from "./interakt.client.js";

export type WaSession = {
  phone: string;
  role: "customer" | "driver";
  state: string;
  ctx: Record<string, unknown>;
  lastOptions: WaOption[];
};

const rowToSession = (r: any): WaSession => ({
  phone: r.phone, role: r.role, state: r.state, ctx: r.ctx ?? {}, lastOptions: r.last_options ?? [],
});

export class WaSessionsRepo {
  constructor(private pool: pg.Pool) {}

  async get(phone: string): Promise<WaSession | null> {
    const { rows } = await this.pool.query(`SELECT * FROM wa_sessions WHERE phone=$1`, [phone]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  // ctx merges (jsonb ||) so flows can add draft fields incrementally;
  // lastOptions replaces wholesale (it always reflects the latest send).
  async upsert(s: {
    phone: string; role: "customer" | "driver"; state: string;
    ctx?: Record<string, unknown>; lastOptions?: WaOption[];
  }): Promise<WaSession> {
    const { rows } = await this.pool.query(
      `INSERT INTO wa_sessions(phone, role, state, ctx, last_options)
       VALUES ($1,$2,$3,$4::jsonb,COALESCE($5::jsonb,'[]'::jsonb))
       ON CONFLICT (phone) DO UPDATE SET
         role=$2, state=$3,
         ctx = wa_sessions.ctx || $4::jsonb,
         last_options = COALESCE($5::jsonb, wa_sessions.last_options),
         updated_at = now()
       RETURNING *`,
      [s.phone, s.role, s.state, JSON.stringify(s.ctx ?? {}), s.lastOptions ? JSON.stringify(s.lastOptions) : null],
    );
    return rowToSession(rows[0]);
  }

  async clear(phone: string): Promise<void> {
    await this.pool.query(`DELETE FROM wa_sessions WHERE phone=$1`, [phone]);
  }

  // Idempotency for Interakt redeliveries: false = already seen. Keeps last 20 ids.
  async markProcessed(phone: string, msgId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE wa_sessions
         SET processed_ids = (ARRAY[$2] || processed_ids)[1:20], updated_at = now()
       WHERE phone=$1 AND NOT ($2 = ANY(processed_ids))`,
      [phone, msgId],
    );
    return (rowCount ?? 0) > 0;
  }
}
```

- [ ] **Step 5: Run tests** — `npx vitest run tests/wa-inbound.test.ts tests/wa-sessions.test.ts` → PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(wa): inbound normalizer + Postgres session store"`

---

### Task 6: LLM load parser

**Files:**
- Create: `src/wa/llm-parse.ts`
- Test: `tests/wa-llm-parse.test.ts`

**Interfaces:**
- Produces:

```ts
export type ParsedLoad = {
  fromText: string | null; toText: string | null; vehicleType: string | null;
  priceInr: number | null; pickupDate: string | null;  // YYYY-MM-DD
};
export function buildLoadParser(config: Config, fetchImpl?: typeof fetch): (text: string, today: string) => Promise<ParsedLoad>
```

Returns all-null fields on any failure (no key, HTTP error, bad JSON) — the guided flow fills the gaps.

- [ ] **Step 1: Failing tests** — `tests/wa-llm-parse.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildLoadParser } from "../src/wa/llm-parse.js";
import { loadConfig } from "../src/config.js";

const baseEnv = {
  DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w", PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
};
const EMPTY = { fromText: null, toText: null, vehicleType: null, priceInr: null, pickupDate: null };

describe("llm load parser", () => {
  it("returns empty without a key (guided flow takes over)", async () => {
    const parse = buildLoadParser(loadConfig(baseEnv as any));
    expect(await parse("16ft mumbai pune 13000", "2026-07-03")).toEqual(EMPTY);
  });

  it("extracts fields from Groq's JSON answer", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ fromText: "Mumbai", toText: "Pune", vehicleType: "16ft", priceInr: 13000, pickupDate: "2026-07-04" }) } }],
    }), { status: 200 })) as unknown as typeof fetch;
    const parse = buildLoadParser(loadConfig({ ...baseEnv, GROQ_API_KEY: "g" } as any), f);
    expect(await parse("16ft mumbai to pune 13000 kal", "2026-07-03")).toEqual({
      fromText: "Mumbai", toText: "Pune", vehicleType: "16ft", priceInr: 13000, pickupDate: "2026-07-04",
    });
    const req = JSON.parse((f as any).mock.calls[0][1].body);
    expect(req.response_format).toEqual({ type: "json_object" });
  });

  it("returns empty on API failure", async () => {
    const f = vi.fn(async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;
    const parse = buildLoadParser(loadConfig({ ...baseEnv, GROQ_API_KEY: "g" } as any), f);
    expect(await parse("anything", "2026-07-03")).toEqual(EMPTY);
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement `src/wa/llm-parse.ts`:**

```ts
import { Config } from "../config.js";

export type ParsedLoad = {
  fromText: string | null;
  toText: string | null;
  vehicleType: string | null;
  priceInr: number | null;
  pickupDate: string | null;
};

const EMPTY: ParsedLoad = { fromText: null, toText: null, vehicleType: null, priceInr: null, pickupDate: null };

const PROMPT = (today: string) => `You extract truck-load requests from short WhatsApp messages (English/Hindi/Hinglish).
Today is ${today}. Reply ONLY with JSON: {"fromText": string|null, "toText": string|null, "vehicleType": string|null, "priceInr": number|null, "pickupDate": "YYYY-MM-DD"|null}.
vehicleType examples: "Tata Ace","14ft","16ft","17ft","19ft","22ft","Container". Resolve relative dates ("kal"/"tomorrow") to a date. Use null for anything not stated.`;

// Best-effort: any failure returns EMPTY and the guided flow asks instead.
export function buildLoadParser(config: Config, fetchImpl: typeof fetch = fetch) {
  return async function parseLoad(text: string, today: string): Promise<ParsedLoad> {
    if (!config.groqApiKey) return EMPTY;
    try {
      const res = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.groqApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.groqModel,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: PROMPT(today) },
            { role: "user", content: text },
          ],
        }),
      });
      if (!res.ok) return EMPTY;
      const data: any = await res.json();
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
      const price = Number(parsed.priceInr);
      return {
        fromText: typeof parsed.fromText === "string" && parsed.fromText ? parsed.fromText : null,
        toText: typeof parsed.toText === "string" && parsed.toText ? parsed.toText : null,
        vehicleType: typeof parsed.vehicleType === "string" && parsed.vehicleType ? parsed.vehicleType : null,
        priceInr: Number.isFinite(price) && price > 0 ? Math.round(price) : null,
        pickupDate: /^\d{4}-\d{2}-\d{2}$/.test(parsed.pickupDate ?? "") ? parsed.pickupDate : null,
      };
    } catch {
      return EMPTY;
    }
  };
}
```

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** — `git commit -am "feat(wa): Groq free-text load parser with guided-flow fallback"`

---

### Task 7: wa-sender + orchestrator channel branch + filled-notices

**Files:**
- Create: `src/wa/wa-sender.ts`
- Modify: `src/calls/orchestrator.ts`, `src/quotes/availability.ts`
- Test: `tests/wa-sender.test.ts`

**Interfaces:**
- Consumes: `InteraktClient` (Task 4), `CallsRepo` channel (Task 2), `recordAvailability` result (Task 3).
- Produces:

```ts
export type WaSender = {
  // WA offer for a call attempt. Sets conversation id `wa_<attempt.id>`, status
  // IN_PROGRESS (awaiting reply). Throws if the send fails (caller falls back to voice).
  sendOffer(attempt: CallAttempt, load: Load, owner: Owner, priceInr: number, flow: CallFlow): Promise<void>;
  // "load filled" notice to a losing WA driver (best-effort)
  sendFilled(phone: string, load: Load): Promise<void>;
  // customer booking confirm with Confirm/Decline buttons (session, template fallback)
  sendConfirm(demand: DemandRequest, load: Load, ownerName: string): Promise<void>;
  sendText(phone: string, text: string): Promise<void>;  // courtesy notices
};
export function buildWaSender(deps: { interakt: InteraktClient; callsRepo: CallsRepo; sessions: WaSessionsRepo; config: Config }): WaSender
```

- Orchestrator: constructor deps gain `waSender?: WaSender`; `placeOne` sends WA when `owner.channel !== "voice"` and `waSender` is set, falling back to voice on send failure. New public method `notifyFilled(loadId, exceptOwnerId)`.
- Button id grammar (≤ 200 chars, parsed by driver/customer flows in Task 8): `acc:<attemptId>:<priceInr>` · `ctr:<attemptId>` · `no:<attemptId>` · `bok:<demandId>` · `dec:<demandId>`.

- [ ] **Step 1: Failing tests** — `tests/wa-sender.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { CallsRepo } from "../src/calls/calls.repo.js";
import { InteraktClient } from "../src/wa/interakt.client.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1", INTERAKT_API_KEY: "ik",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };

export function fakeInterakt(failTemplates = false) {
  const sent: { kind: string; to: string; args: any[] }[] = [];
  const rec = (kind: string) => async (to: string, ...args: any[]) => {
    if (failTemplates && kind === "template") throw new Error("template not approved");
    sent.push({ kind, to, args });
    return args[2] ?? [];
  };
  const client = {
    sendText: rec("text"), sendButtons: rec("buttons"), sendList: rec("list"), sendTemplate: rec("template"),
  } as unknown as InteraktClient;
  return { client, sent };
}

describe("wa channel in the orchestrator", () => {
  it("whatsapp-preference owner gets a template offer, not a voice call", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const placed: any[] = [];
    const el = { originateCall: async (a: any) => (placed.push(a), { conversationId: `c${placed.length}` }) };
    const app = buildServer({ pool, config, el, interakt: client });

    const owner = (await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "W", phone: "+919111111177", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }], channel: "whatsapp" } })).json();
    const load = (await app.inject({ method: "POST", url: "/loads", headers: auth,
      payload: { fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" } })).json();
    await app.inject({ method: "POST", url: `/loads/${load.id}/call`, headers: auth, payload: { ownerIds: [owner.id] } });

    expect(placed).toHaveLength(0);
    expect(sent.filter((s) => s.kind === "template")).toHaveLength(1);
    const calls = (await app.inject({ method: "GET", url: `/loads/${load.id}/calls`, headers: auth })).json();
    expect(calls[0]).toMatchObject({ channel: "wa", status: "IN_PROGRESS" });
    expect(calls[0].elConversationId).toBe(`wa_${calls[0].id}`);
  });

  it("falls back to a voice call when the WA send fails", async () => {
    const { pool } = await withTestDb();
    const { client } = fakeInterakt(true); // template send throws
    const placed: any[] = [];
    const el = { originateCall: async (a: any) => (placed.push(a), { conversationId: `c${placed.length}` }) };
    const app = buildServer({ pool, config, el, interakt: client });

    const owner = (await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "W2", phone: "+919111111166", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }], channel: "whatsapp" } })).json();
    const load = (await app.inject({ method: "POST", url: "/loads", headers: auth,
      payload: { fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" } })).json();
    await app.inject({ method: "POST", url: `/loads/${load.id}/call`, headers: auth, payload: { ownerIds: [owner.id] } });

    expect(placed).toHaveLength(1); // voice fallback dialed
    const calls = (await app.inject({ method: "GET", url: `/loads/${load.id}/calls`, headers: auth })).json();
    expect(calls[0].channel).toBe("voice"); // fell back
  });
});
```

Note: `buildServer` gains an optional `interakt?: InteraktClient` dep (wired in Step 3).

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement.**

`src/wa/wa-sender.ts`:

```ts
import { Config } from "../config.js";
import { InteraktClient } from "./interakt.client.js";
import { WaSessionsRepo } from "./wa-sessions.repo.js";
import { CallsRepo, CallAttempt, CallFlow } from "../calls/calls.repo.js";
import { Load } from "../loads/loads.schema.js";
import { Owner } from "../owners/owners.schema.js";
import { DemandRequest } from "../demand/demand.repo.js";

export const digits = (phone: string) => phone.replace(/\D/g, "");
export const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export type WaSender = {
  sendOffer(attempt: CallAttempt, load: Load, owner: Owner, priceInr: number, flow: CallFlow): Promise<void>;
  sendFilled(phone: string, load: Load): Promise<void>;
  sendConfirm(demand: DemandRequest, load: Load, ownerName: string): Promise<void>;
  sendText(phone: string, text: string): Promise<void>;
};

export function buildWaSender(deps: {
  interakt: InteraktClient;
  callsRepo: CallsRepo;
  sessions: WaSessionsRepo;
  config: Config;
}): WaSender {
  const route = (load: Load) => `${load.fromLocation} → ${load.toLocation}`;

  return {
    // Template send (business-initiated). Conversation id wa_<attemptId> ties the
    // driver's reply back to this attempt through the normal quotes path.
    async sendOffer(attempt, load, owner, priceInr, flow) {
      const to = digits(owner.phone);
      const buttons = [
        { id: `acc:${attempt.id}:${priceInr}`, title: `Accept ${inr(priceInr)}`.slice(0, 20) },
        ...(flow === "offer" ? [{ id: `ctr:${attempt.id}`, title: "My price" }] : []),
        { id: `no:${attempt.id}`, title: "Not available" },
      ];
      await deps.interakt.sendTemplate(
        to,
        "sourcing_offer",
        [route(load), load.vehicleType, load.pickupDate, String(priceInr)],
        Object.fromEntries(buttons.map((b, i) => [String(i), [b.id]])),
      );
      await deps.callsRepo.setConversationId(attempt.id, `wa_${attempt.id}`);
      await deps.callsRepo.setStatus(attempt.id, "IN_PROGRESS");
      // template button clicks can come back title-only — remember the mapping
      await deps.sessions.upsert({ phone: to, role: "driver", state: "OFFERED", ctx: { attemptId: attempt.id, priceInr }, lastOptions: buttons });
    },

    async sendFilled(phone, load) {
      try {
        await deps.interakt.sendText(digits(phone), `This load (${route(load)}) has been filled. Next time! 🙏 — ${deps.config.companyName}`);
      } catch { /* best-effort */ }
    },

    // Session buttons first (customer messaged us recently in every normal domino
    // run); approved template as the out-of-window fallback.
    async sendConfirm(demand, load, ownerName) {
      const to = digits(demand.customerPhone);
      const price = demand.lockedPriceInr ?? load.fixedPriceInr;
      const buttons = [
        { id: `bok:${demand.id}`, title: "Confirm booking" },
        { id: `dec:${demand.id}`, title: "Decline" },
      ];
      const body =
        `🚛 Driver found!\n${route(load)} · ${load.vehicleType} · ${load.pickupDate}\n` +
        `Agreed price: ${inr(price)}\nDriver: ${ownerName}\n\nBook this trip?`;
      try {
        const opts = await deps.interakt.sendButtons(to, body, buttons);
        await deps.sessions.upsert({ phone: to, role: "customer", state: "CONFIRM_BOOKING", ctx: { demandId: demand.id }, lastOptions: opts });
      } catch {
        await deps.interakt.sendTemplate(to, "sourcing_confirm",
          [route(load), String(price), ownerName],
          { "0": [buttons[0].id], "1": [buttons[1].id] });
        await deps.sessions.upsert({ phone: to, role: "customer", state: "CONFIRM_BOOKING", ctx: { demandId: demand.id }, lastOptions: buttons });
      }
    },

    async sendText(phone, text) {
      try {
        await deps.interakt.sendText(digits(phone), text);
      } catch { /* best-effort */ }
    },
  };
}
```

`src/calls/orchestrator.ts` — deps gain `waSender?: WaSender`. In `enqueue`, pass the owner's channel when creating attempts:

```ts
      const wantsWa = !!this.d.waSender && owner.channel !== "voice";
      const attempt = await this.d.callsRepo.create({
        loadId, ownerId, phone: owner.phone, flow, channel: wantsWa ? "wa" : "voice",
      });
```

In `placeOne`, before the voice retry loop:

```ts
    // WhatsApp-preference owners get a message instead of a call; if the send
    // fails (e.g. template not approved yet) fall back to a voice call so nobody
    // is skipped. ponytail: 'both' == 'whatsapp' for now; voice-after-TTL later.
    if (a.channel === "wa" && this.d.waSender) {
      try {
        const priceInr = offerPriceInr ?? load.fixedPriceInr;
        await this.d.waSender.sendOffer(a, load, owner, priceInr, flow);
        return;
      } catch {
        await this.d.callsRepo.setChannel(a.id, "voice");
        a = { ...a, channel: "voice" };
      }
    }
```

Add to `CallsRepo`: `async setChannel(id: string, channel: CallChannel): Promise<void>` (`UPDATE call_attempts SET channel=$2 WHERE id=$1`).

Add to `CallOrchestrator`:

```ts
  // Losing WA drivers get a "filled" notice when someone locks the load.
  // Must run BEFORE supersedePending flips their live status.
  async notifyFilled(loadId: string, exceptOwnerId: string): Promise<void> {
    if (!this.d.waSender) return;
    const load = await this.d.loadsRepo.getLoad(loadId);
    if (!load) return;
    const peers = await this.d.callsRepo.listLivePeersByLoad(loadId, exceptOwnerId);
    for (const p of peers.filter((p) => p.channel === "wa")) await this.d.waSender.sendFilled(p.phone, load);
  }
```

In `src/quotes/availability.ts`, `AvailabilityDeps` gains `orchestrator?: { notifyFilled(loadId: string, exceptOwnerId: string): Promise<void> }`; call `await deps.orchestrator?.notifyFilled(call.loadId, call.ownerId)` immediately before each `supersedePending` call. Pass `orchestrator` through from `webhooks.routes.ts`.

`src/server.ts` — deps gain `interakt?: InteraktClient`; build the WA pieces before the orchestrator:

```ts
  const waSessions = new WaSessionsRepo(deps.pool);
  const interakt = deps.interakt ?? (deps.config.waEnabled ? buildInteraktClient(deps.config) : undefined);
  const waSender = interakt
    ? buildWaSender({ interakt, callsRepo, sessions: waSessions, config: deps.config })
    : undefined;
  // …orchestrator gets { ...existing, waSender }
```

- [ ] **Step 4: Run** — `npx vitest run tests/wa-sender.test.ts` then the FULL suite → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(wa): wa-sender offers/confirm/filled + orchestrator channel branch with voice fallback"`

---

### Task 8: Driver flow

**Files:**
- Create: `src/wa/driver-flow.ts`
- Test: `tests/wa-driver-flow.test.ts`

**Interfaces:**
- Consumes: `WaInbound` (Task 5), `recordAvailability` (Task 3), button grammar (Task 7).
- Produces:

```ts
export type DriverFlowDeps = {
  availability: AvailabilityDeps;           // passed straight to recordAvailability
  orchestrator: CallOrchestrator;           // notifyFilled on lock
  interakt: InteraktClient;
  sessions: WaSessionsRepo;
  callsRepo: CallsRepo;
  loadsRepo: LoadsRepo;
  config: Config;
};
export async function handleDriverMessage(deps: DriverFlowDeps, m: WaInbound, session: WaSession | null): Promise<void>
```

Reply handling: `acc:<attemptId>:<price>` → `recordAvailability({cid: wa_<attemptId>, available: "YES", acceptsFixed: true, lockPriceInr: price})`, mark attempt DONE, reply won/lost text. `ctr:<attemptId>` → prompt for amount, session state `AWAIT_PRICE`. `no:<attemptId>` → availability NO, attempt DONE. Free text in `AWAIT_PRICE` → digits parse → `recordAvailability({available: "YES", acceptsFixed: false, quotedPriceInr})`, attempt DONE, "passed to our team" reply; unparseable → one re-ask.

- [ ] **Step 1: Failing tests** — `tests/wa-driver-flow.test.ts` (full-stack through `buildServer` + a helper that POSTs a fixture to `/wa/inbound` won't exist until Task 10, so test the function directly):

```ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";
import { CallsRepo } from "../src/calls/calls.repo.js";
import { QuotesRepo } from "../src/quotes/quotes.repo.js";
import { DemandRepo } from "../src/demand/demand.repo.js";
import { WaSessionsRepo } from "../src/wa/wa-sessions.repo.js";
import { handleDriverMessage } from "../src/wa/driver-flow.js";
import { fakeInterakt } from "./wa-sender.test.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", INTERAKT_API_KEY: "ik",
} as NodeJS.ProcessEnv);

async function setup(pool: any) {
  const owners = new OwnersRepo(pool), loads = new LoadsRepo(pool), calls = new CallsRepo(pool);
  const quotes = new QuotesRepo(pool), demand = new DemandRepo(pool), sessions = new WaSessionsRepo(pool);
  const owner = await owners.createOwner({ name: "R", phone: "+919111111155", vehicleTypes: ["16ft"], lanes: [], channel: "whatsapp" } as any);
  const load = await loads.createLoad({ fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" });
  await loads.setStatus(load.id, "CALLING");
  const attempt = await calls.create({ loadId: load.id, ownerId: owner.id, phone: owner.phone, flow: "offer", channel: "wa" });
  await calls.setConversationId(attempt.id, `wa_${attempt.id}`);
  await calls.setStatus(attempt.id, "IN_PROGRESS");
  const { client, sent } = fakeInterakt();
  const deps = {
    availability: { quotesRepo: quotes, callsRepo: calls, loadsRepo: loads, demandRepo: demand },
    orchestrator: { notifyFilled: async () => {} } as any,
    interakt: client, sessions, callsRepo: calls, loadsRepo: loads, config,
  };
  return { deps, sent, owner, load, attempt, calls, quotes, sessions };
}
const msg = (from: string, over: any) => ({ from, msgId: `m${Math.random()}`, contactName: "R", ...over });

describe("driver flow", () => {
  it("accept locks the load and confirms to the driver", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, load, attempt, calls } = await setup(pool);
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "reply", replyId: `acc:${attempt.id}:13000` }) as any, null);
    expect((await calls.getById(attempt.id))!.status).toBe("DONE");
    const { LoadsRepo } = await import("../src/loads/loads.repo.js");
    expect((await new LoadsRepo(pool).getLoad(load.id))!.status).toBe("LOCKED");
    expect(sent.some((s) => s.kind === "text" && /yours/i.test(s.args[0]))).toBe(true);
  });

  it("counter asks for the amount, then records the quote", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, attempt, quotes, load } = await setup(pool);
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "reply", replyId: `ctr:${attempt.id}` }) as any, null);
    expect(sent.some((s) => s.kind === "text" && /price/i.test(s.args[0]))).toBe(true);
    const session = { phone: "919111111155", role: "driver", state: "AWAIT_PRICE", ctx: { attemptId: attempt.id }, lastOptions: [] };
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "text", text: "14,000 rs" }) as any, session as any);
    const qs = await quotes.listByLoad(load.id);
    expect(qs[0]).toMatchObject({ available: "YES", acceptsFixed: false, quotedPriceInr: 14000 });
  });

  it("no marks unavailable", async () => {
    const { pool } = await withTestDb();
    const { deps, attempt, quotes, load } = await setup(pool);
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "reply", replyId: `no:${attempt.id}` }) as any, null);
    const qs = await quotes.listByLoad(load.id);
    expect(qs[0].available).toBe("NO");
  });

  it("unparseable price re-asks once", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, attempt } = await setup(pool);
    const session = { phone: "919111111155", role: "driver", state: "AWAIT_PRICE", ctx: { attemptId: attempt.id }, lastOptions: [] };
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "text", text: "hmm thinking" }) as any, session as any);
    expect(sent.filter((s) => s.kind === "text").length).toBe(1); // re-ask, no quote
  });
});
```

(If `quotes.listByLoad` doesn't exist under that name, use the actual list method in `src/quotes/quotes.repo.ts` — check before writing the test and keep the assertion the same.)

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement `src/wa/driver-flow.ts`:**

```ts
import { Config } from "../config.js";
import { WaInbound } from "./inbound.js";
import { WaSession, WaSessionsRepo } from "./wa-sessions.repo.js";
import { InteraktClient } from "./interakt.client.js";
import { recordAvailability, AvailabilityDeps } from "../quotes/availability.js";
import { CallsRepo } from "../calls/calls.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { CallOrchestrator } from "../calls/orchestrator.js";
import { inr } from "./wa-sender.js";

export type DriverFlowDeps = {
  availability: AvailabilityDeps;
  orchestrator: Pick<CallOrchestrator, "notifyFilled">;
  interakt: InteraktClient;
  sessions: WaSessionsRepo;
  callsRepo: CallsRepo;
  loadsRepo: LoadsRepo;
  config: Config;
};

const parsePrice = (s: string): number | null => {
  const n = Number((s || "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n >= 100 ? n : null; // <100 is never a freight price
};

export async function handleDriverMessage(deps: DriverFlowDeps, m: WaInbound, session: WaSession | null): Promise<void> {
  const say = (t: string) => deps.interakt.sendText(m.from, t);

  if (m.kind === "reply" && m.replyId) {
    const [verb, attemptId, priceStr] = m.replyId.split(":");
    const cid = `wa_${attemptId}`;

    if (verb === "acc") {
      const price = Number(priceStr) || undefined;
      const r = await recordAvailability(deps.availability, {
        cid, available: "YES", acceptsFixed: true, lockPriceInr: price ?? null,
      });
      if (r.ok && r.locked && r.loadId && r.ownerId) await deps.orchestrator.notifyFilled(r.loadId, r.ownerId);
      await deps.callsRepo.setStatus(attemptId, "DONE", { ended: true });
      await deps.sessions.clear(m.from);
      await say(
        r.ok && r.locked
          ? `🎉 The load is yours at ${inr(price ?? 0)}. ${deps.config.companyName} will confirm pickup details shortly.`
          : `Sorry — this load was just filled by another driver. Next time! 🙏`,
      );
      return;
    }

    if (verb === "ctr") {
      await deps.sessions.upsert({ phone: m.from, role: "driver", state: "AWAIT_PRICE", ctx: { attemptId } });
      await say("What's your price for this trip? Reply with the amount (₹).");
      return;
    }

    if (verb === "no") {
      await recordAvailability(deps.availability, { cid, available: "NO" });
      await deps.callsRepo.setStatus(attemptId, "DONE", { ended: true });
      await deps.sessions.clear(m.from);
      await say(`No problem — we'll keep you posted on the next load. 🙏`);
      return;
    }
  }

  // free text while we're waiting on their counter amount
  if (session?.state === "AWAIT_PRICE" && m.kind === "text") {
    const attemptId = String(session.ctx.attemptId ?? "");
    const price = parsePrice(m.text ?? "");
    if (!price) {
      await say("Please reply with just the amount, e.g. 14000");
      return;
    }
    await recordAvailability(deps.availability, {
      cid: `wa_${attemptId}`, available: "YES", acceptsFixed: false, quotedPriceInr: price,
    });
    await deps.callsRepo.setStatus(attemptId, "DONE", { ended: true });
    await deps.sessions.clear(m.from);
    await say(`Got it — ${inr(price)} passed to our team. We'll get back to you shortly.`);
    return;
  }

  // a driver texting outside any active offer
  await say(`Namaste! We'll message you here when a load matches your route. — ${deps.config.companyName}`);
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/wa-driver-flow.test.ts` → PASS. Then FULL suite.

- [ ] **Step 5: Commit** — `git commit -am "feat(wa): driver flow (accept locks with filled-notices, counter capture, decline)"`

---

### Task 9: Customer flow

**Files:**
- Create: `src/wa/customer-flow.ts`
- Modify: `src/demand/demand.repo.ts` (channel), `src/demand/sourcing.ts` (shared capture helper)
- Test: `tests/wa-customer-flow.test.ts`

**Interfaces:**
- Consumes: `parseLoad` (Task 6), `sourceDemand`/`SourcingDeps` (existing), geo resolver.
- Produces:

```ts
// demand.repo.ts: DemandInput + DemandRequest gain  channel: "voice"|"whatsapp"|"console"
//   (DemandInput optional, default "voice"; INSERT includes the column; rowToDemand maps it)
// sourcing.ts:
export type CaptureDeps = SourcingDeps & { geo: GeoResolver };
export async function captureDemand(deps: CaptureDeps, input: {
  customerPhone: string; fromText: string; toText: string; vehicleType?: string | null;
  offeredPriceInr?: number | null; pickupDate?: string | null; conversationId: string;
  channel?: "voice" | "whatsapp" | "console"; note?: string | null;
}): Promise<{ created: boolean; demand: DemandRequest; sourcing: { sourced: boolean; reason?: string; calledOwners?: number } }>
// customer-flow.ts:
export type CustomerFlowDeps = {
  capture: CaptureDeps; interakt: InteraktClient; sessions: WaSessionsRepo;
  demandRepo: DemandRepo; loadsRepo: LoadsRepo; parseLoad: (text: string, today: string) => Promise<ParsedLoad>;
  config: Config;
};
export async function handleCustomerMessage(deps: CustomerFlowDeps, m: WaInbound, session: WaSession | null): Promise<void>
```

States: `ASK_FROM → ASK_TO → ASK_VEHICLE → ASK_DATE → ASK_PRICE → CONFIRM → (submitted)` plus `CONFIRM_BOOKING` (set by `sendConfirm` in Task 7). Draft lives in `session.ctx.draft`. Widget per field: vehicle = list (`veh:<type>` ids from `["Tata Ace","14ft","16ft","17ft","19ft","22ft","Container"]`), date = buttons (`date:today`/`date:tomorrow`/`date:type`), from/to/price = text prompts. Any new free text in an empty session runs `parseLoad` first, then asks only for missing fields (`nextPrompt()` helper walks the draft in field order). `CONFIRM` shows the summary with `cfm:yes` / `cfm:edit` / `cfm:no` buttons; `cfm:yes` calls `captureDemand(channel: "whatsapp", conversationId: "wa_" + msgId)` and replies sourced/queued copy; `cfm:edit` re-sends prompts from `ASK_FROM` keeping the draft (each prompt offers "keep <current>" via a `keep` button); `cfm:no` clears the session. `CONFIRM_BOOKING` replies: `bok:<demandId>` → `demandRepo.book` + `loadsRepo.setStatus(BOOKED)` + "🎉 Booked!"; `dec:<demandId>` → `setStatus(DECLINED)` + load CLOSED + courtesy text.

- [ ] **Step 1: Refactor `report-demand`.** Add `channel` to `demand_requests` mapping in `demand.repo.ts` (INSERT column + `rowToDemand`), move the geo-resolve + upsert + auto-source block from `webhooks.routes.ts:170-212` into `captureDemand` in `sourcing.ts` (keeping the ISO-date/note handling), and rewire the webhook route to call it with `channel: "voice"`. Run FULL suite → PASS (refactor only). Commit: `git commit -am "refactor: extract captureDemand; demand channel column"`.

- [ ] **Step 2: Failing tests** — `tests/wa-customer-flow.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";
import { CallsRepo } from "../src/calls/calls.repo.js";
import { DemandRepo } from "../src/demand/demand.repo.js";
import { WaSessionsRepo } from "../src/wa/wa-sessions.repo.js";
import { CallOrchestrator } from "../src/calls/orchestrator.js";
import { handleCustomerMessage } from "../src/wa/customer-flow.js";
import { fakeInterakt } from "./wa-sender.test.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1", INTERAKT_API_KEY: "ik",
} as NodeJS.ProcessEnv);
const fakeGeo = { async resolveLocation(text: string) {
  return { raw: text, canonical: text, city: text, state: "MH", lat: 19.1, lng: 72.8, source: "test" };
} };

async function setup(pool: any) {
  const owners = new OwnersRepo(pool), loads = new LoadsRepo(pool), calls = new CallsRepo(pool);
  const demand = new DemandRepo(pool), sessions = new WaSessionsRepo(pool);
  await owners.createOwner({ name: "D", phone: "+919111111144", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }] });
  const el = { originateCall: async () => ({ conversationId: `c${Math.random()}` }) };
  const orchestrator = new CallOrchestrator({ pool, config, el: el as any, ownersRepo: owners, loadsRepo: loads, callsRepo: calls });
  const { client, sent } = fakeInterakt();
  const parsed = { fromText: "Mumbai", toText: "Pune", vehicleType: "16ft", priceInr: 13000, pickupDate: "2026-07-05" };
  const deps = {
    capture: { demandRepo: demand, loadsRepo: loads, ownersRepo: owners, callsRepo: calls, orchestrator, geo: fakeGeo },
    interakt: client, sessions, demandRepo: demand, loadsRepo: loads,
    parseLoad: async () => parsed, config,
  };
  return { deps, sent, sessions, demand, loads, parsed };
}
const msg = (over: any) => ({ from: "919888888833", msgId: `m${Math.random()}`, contactName: "C", ...over });

describe("customer flow", () => {
  it("one-shot parse → confirm summary → sourced demand with channel whatsapp", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, sessions, demand } = await setup(pool);
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "16ft mumbai pune 13000 for 5 july" }) as any, null);
    // summary with confirm buttons
    expect(sent.some((s) => s.kind === "buttons" && /Mumbai/.test(s.args[0]) && /13,000/.test(s.args[0]))).toBe(true);
    const session = await sessions.get("919888888833");
    expect(session!.state).toBe("CONFIRM");
    await handleCustomerMessage(deps as any, msg({ kind: "reply", replyId: "cfm:yes" }) as any, session);
    const demands = await demand.list();
    expect(demands[0]).toMatchObject({ channel: "whatsapp", status: "SOURCING", offeredPriceInr: 13000 });
    expect(sent.some((s) => s.kind === "text" && /truck/i.test(s.args[0]))).toBe(true);
  });

  it("missing vehicle → asks with a list, fills, then confirms", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, sessions } = await setup(pool);
    (deps as any).parseLoad = async () => ({ fromText: "Mumbai", toText: "Pune", vehicleType: null, priceInr: 13000, pickupDate: "2026-07-05" });
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "mumbai pune 13000" }) as any, null);
    expect(sent.some((s) => s.kind === "list")).toBe(true);
    let session = await sessions.get("919888888833");
    expect(session!.state).toBe("ASK_VEHICLE");
    await handleCustomerMessage(deps as any, msg({ kind: "reply", replyId: "veh:16ft" }) as any, session);
    session = await sessions.get("919888888833");
    expect(session!.state).toBe("CONFIRM");
  });

  it("booking confirm tap books the demand", async () => {
    const { pool } = await withTestDb();
    const { deps, sessions, demand, loads } = await setup(pool);
    const load = await loads.createLoad({ fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" });
    const { demand: d } = await demand.upsertByConversation({
      customerPhone: "+919888888833", fromText: "Mumbai", toText: "Pune", vehicleType: "16ft",
      offeredPriceInr: 13000, pickupDate: "2026-07-05", elConversationId: "wa_test1", channel: "whatsapp",
    } as any);
    await demand.attachLoad(d.id, load.id);
    await demand.setStatus(d.id, "SOURCING");
    await demand.lockDriver(load.id, (await new OwnersRepo(pool).listOwners())[0].id, 14000);
    await demand.approveValue(d.id);
    const session = { phone: "919888888833", role: "customer", state: "CONFIRM_BOOKING", ctx: { demandId: d.id }, lastOptions: [] };
    await handleCustomerMessage(deps as any, msg({ kind: "reply", replyId: `bok:${d.id}` }) as any, session as any);
    expect((await demand.getById(d.id))!.status).toBe("BOOKED");
    expect((await loads.getLoad(load.id))!.status).toBe("BOOKED");
  });
});
```

- [ ] **Step 3: Run to verify FAIL.**

- [ ] **Step 4: Implement `src/wa/customer-flow.ts`:**

```ts
import { Config } from "../config.js";
import { WaInbound } from "./inbound.js";
import { WaSession, WaSessionsRepo } from "./wa-sessions.repo.js";
import { InteraktClient } from "./interakt.client.js";
import { CaptureDeps, captureDemand } from "../demand/sourcing.js";
import { DemandRepo } from "../demand/demand.repo.js";
import { LoadsRepo } from "../loads/loads.repo.js";
import { ParsedLoad } from "./llm-parse.js";
import { inr } from "./wa-sender.js";

export type CustomerFlowDeps = {
  capture: CaptureDeps;
  interakt: InteraktClient;
  sessions: WaSessionsRepo;
  demandRepo: DemandRepo;
  loadsRepo: LoadsRepo;
  parseLoad: (text: string, today: string) => Promise<ParsedLoad>;
  config: Config;
};

type Draft = { fromText?: string; toText?: string; vehicleType?: string; priceInr?: number; pickupDate?: string };
const VEHICLES = ["Tata Ace", "14ft", "16ft", "17ft", "19ft", "22ft", "Container"];
const todayIso = (d = new Date()) => d.toISOString().slice(0, 10);
const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return todayIso(d); };

// The next field the draft is missing, in ask-order. null = ready to confirm.
function nextField(d: Draft): "fromText" | "toText" | "vehicleType" | "pickupDate" | "priceInr" | null {
  if (!d.fromText) return "fromText";
  if (!d.toText) return "toText";
  if (!d.vehicleType) return "vehicleType";
  if (!d.pickupDate) return "pickupDate";
  if (!d.priceInr) return "priceInr";
  return null;
}

async function prompt(deps: CustomerFlowDeps, phone: string, draft: Draft): Promise<void> {
  const field = nextField(draft);
  if (field === null) {
    const body =
      `📋 Load summary\n${draft.fromText} → ${draft.toText} · ${draft.vehicleType}\n` +
      `Pickup ${draft.pickupDate} · ${inr(draft.priceInr!)}\n\nPost this load?`;
    const opts = await deps.interakt.sendButtons(phone, body, [
      { id: "cfm:yes", title: "✅ Confirm" }, { id: "cfm:edit", title: "✏️ Edit" }, { id: "cfm:no", title: "❌ Cancel" },
    ]);
    await deps.sessions.upsert({ phone, role: "customer", state: "CONFIRM", ctx: { draft }, lastOptions: opts });
    return;
  }
  const state = { fromText: "ASK_FROM", toText: "ASK_TO", vehicleType: "ASK_VEHICLE", pickupDate: "ASK_DATE", priceInr: "ASK_PRICE" }[field];
  let opts: { id: string; title: string }[] = [];
  if (field === "vehicleType") {
    opts = await deps.interakt.sendList(phone, "Which vehicle do you need?", "Choose vehicle",
      VEHICLES.map((v) => ({ id: `veh:${v}`, title: v })));
  } else if (field === "pickupDate") {
    opts = await deps.interakt.sendButtons(phone, "When is the pickup?", [
      { id: "date:today", title: "Today" }, { id: "date:tomorrow", title: "Tomorrow" }, { id: "date:type", title: "Type a date" },
    ]);
  } else {
    const q = { fromText: "Pickup city?", toText: "Drop city?", priceInr: "Your price for this trip? (₹)" }[field];
    await deps.interakt.sendText(phone, q!);
  }
  await deps.sessions.upsert({ phone, role: "customer", state, ctx: { draft }, lastOptions: opts });
}

export async function handleCustomerMessage(deps: CustomerFlowDeps, m: WaInbound, session: WaSession | null): Promise<void> {
  const say = (t: string) => deps.interakt.sendText(m.from, t);
  const draft: Draft = { ...((session?.ctx?.draft as Draft) ?? {}) };
  const state = session?.state ?? "IDLE";

  // ---- booking confirm (domino step 4) ----
  if (state === "CONFIRM_BOOKING" && m.kind === "reply" && m.replyId) {
    const [verb, demandId] = m.replyId.split(":");
    const d = await deps.demandRepo.getById(demandId);
    if (d && verb === "bok") {
      const booked = await deps.demandRepo.book(d.id);
      if (booked && d.loadId) await deps.loadsRepo.setStatus(d.loadId, "BOOKED");
      await deps.sessions.clear(m.from);
      await say(booked ? "🎉 Booked! The driver will call you before pickup." : "This booking is no longer pending.");
      return;
    }
    if (d && verb === "dec") {
      await deps.demandRepo.setStatus(d.id, "DECLINED");
      if (d.loadId) await deps.loadsRepo.setStatus(d.loadId, "CLOSED");
      await deps.sessions.clear(m.from);
      await say("No problem — the booking is cancelled. Message us anytime for a new load.");
      return;
    }
  }

  // ---- confirm-summary buttons ----
  if (state === "CONFIRM" && m.kind === "reply") {
    if (m.replyId === "cfm:yes") {
      const r = await captureDemand(deps.capture, {
        customerPhone: `+${m.from}`, fromText: draft.fromText!, toText: draft.toText!,
        vehicleType: draft.vehicleType, offeredPriceInr: draft.priceInr, pickupDate: draft.pickupDate,
        conversationId: `wa_${m.msgId}`, channel: "whatsapp",
      });
      await deps.sessions.clear(m.from);
      await say(r.sourcing.sourced
        ? "🔎 Finding you a truck — I'll message you here as soon as a driver is confirmed."
        : "✅ Load received! Our team will arrange a truck and message you here.");
      return;
    }
    if (m.replyId === "cfm:edit") {
      // start over, keeping nothing typed wrong: clear draft, re-ask from the top
      await deps.sessions.upsert({ phone: m.from, role: "customer", state: "ASK_FROM", ctx: { draft: {} }, lastOptions: [] });
      await say("Okay, let's redo it. Pickup city?");
      return;
    }
    if (m.replyId === "cfm:no") {
      await deps.sessions.clear(m.from);
      await say("Cancelled. Message me the route + vehicle + price anytime to post a load.");
      return;
    }
  }

  // ---- field answers ----
  if (state === "ASK_VEHICLE" && m.kind === "reply" && m.replyId?.startsWith("veh:")) {
    draft.vehicleType = m.replyId.slice(4);
    return prompt(deps, m.from, draft);
  }
  if (state === "ASK_DATE") {
    if (m.kind === "reply" && m.replyId === "date:today") { draft.pickupDate = todayIso(); return prompt(deps, m.from, draft); }
    if (m.kind === "reply" && m.replyId === "date:tomorrow") { draft.pickupDate = plusDays(1); return prompt(deps, m.from, draft); }
    if (m.kind === "reply" && m.replyId === "date:type") { await say("Please type the date as YYYY-MM-DD (e.g. 2026-07-05)."); return; }
    if (m.kind === "text" && /^\d{4}-\d{2}-\d{2}$/.test(m.text ?? "")) { draft.pickupDate = m.text!; return prompt(deps, m.from, draft); }
    await say("Please pick a date, or type it as YYYY-MM-DD.");
    return;
  }
  if (state === "ASK_PRICE" && m.kind === "text") {
    const n = Number((m.text ?? "").replace(/[^\d]/g, ""));
    if (Number.isFinite(n) && n >= 100) { draft.priceInr = n; return prompt(deps, m.from, draft); }
    await say("Please reply with just the amount, e.g. 13000");
    return;
  }
  if (state === "ASK_FROM" && m.kind === "text" && m.text) { draft.fromText = m.text; return prompt(deps, m.from, draft); }
  if (state === "ASK_TO" && m.kind === "text" && m.text) { draft.toText = m.text; return prompt(deps, m.from, draft); }

  // ---- fresh message: try the one-shot parse ----
  if (m.kind === "text" && m.text) {
    const p = await deps.parseLoad(m.text, todayIso());
    const parsedDraft: Draft = {
      fromText: p.fromText ?? undefined, toText: p.toText ?? undefined, vehicleType: p.vehicleType ?? undefined,
      priceInr: p.priceInr ?? undefined, pickupDate: p.pickupDate ?? undefined,
    };
    if (nextField(parsedDraft) === "fromText" && !p.toText) {
      // nothing usable parsed — greet + start guided
      await say(`Namaste ${m.contactName}! 🚛 Tell me your load — e.g. "16ft Mumbai to Pune ₹13000 tomorrow" — or answer step by step.`);
    }
    return prompt(deps, m.from, parsedDraft);
  }

  await say(`Namaste! Send me your load — route, vehicle and price — and I'll find you a truck. — ${deps.config.companyName}`);
}
```

- [ ] **Step 5: Run** — `npx vitest run tests/wa-customer-flow.test.ts` then FULL suite → PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(wa): customer intake flow (LLM one-shot + guided fill + confirm) and WA booking confirm"`

---

### Task 10: Webhook route + router + server wiring

**Files:**
- Create: `src/wa/wa.routes.ts`
- Modify: `src/server.ts`
- Test: `tests/wa-routes.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `POST /wa/inbound` — HMAC-guarded (header `interakt-signature` = `sha256=<hex hmac of raw body>`, keyed by `config.interaktWebhookSecret`; check skipped when the secret is unset), acks `{ status: "ok" }` immediately, processes async. Routing: `ownersRepo.findByPhoneDigits(from)` hit **or** an active driver session → driver flow; else customer flow. Idempotent per `msgId` via `sessions.markProcessed` (session auto-created for first-time senders before the check).

- [ ] **Step 1: Failing tests** — `tests/wa-routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fakeInterakt } from "./wa-sender.test.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", INTERAKT_API_KEY: "ik", INTERAKT_WEBHOOK_SECRET: "sekrit",
  MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };

const inbound = (text: string, phone = "+919888888822") => ({
  type: "message_received",
  data: { customer: { channel_phone_number: phone, traits: { name: "C" } },
          message: { id: `m_${text}`, message_content_type: "Text", message: text } },
});
const sign = (body: string) => "sha256=" + crypto.createHmac("sha256", "sekrit").update(body).digest("hex");
const post = (app: any, payload: any, sig?: string) => {
  const body = JSON.stringify(payload);
  return app.inject({ method: "POST", url: "/wa/inbound", payload: body,
    headers: { "content-type": "application/json", "interakt-signature": sig ?? sign(body) } });
};

describe("POST /wa/inbound", () => {
  it("rejects a bad signature", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config, interakt: fakeInterakt().client, el: { originateCall: async () => ({ conversationId: "c" }) } as any });
    const res = await post(app, inbound("hi"), "sha256=deadbeef");
    expect(res.statusCode).toBe(401);
  });

  it("acks 200 and drives the customer flow", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const app = buildServer({ pool, config, interakt: client, el: { originateCall: async () => ({ conversationId: "c" }) } as any });
    const res = await post(app, inbound("hello"));
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50)); // async processing
    expect(sent.length).toBeGreaterThan(0); // greeted / prompted
  });

  it("is idempotent on message id", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const app = buildServer({ pool, config, interakt: client, el: { originateCall: async () => ({ conversationId: "c" }) } as any });
    await post(app, inbound("same"));
    await new Promise((r) => setTimeout(r, 50));
    const n = sent.length;
    await post(app, inbound("same")); // identical msg id m_same
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.length).toBe(n);
  });

  it("routes a known owner phone to the driver flow", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const app = buildServer({ pool, config, interakt: client, el: { originateCall: async () => ({ conversationId: "c" }) } as any });
    await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "R", phone: "+919111111133", vehicleTypes: ["16ft"], lanes: [] } });
    await post(app, inbound("hello", "+919111111133"));
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.some((s) => s.kind === "text" && /load matches your route/i.test(s.args[0]))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement `src/wa/wa.routes.ts`:**

```ts
import crypto from "node:crypto";
import { FastifyInstance } from "fastify";
import { Config } from "../config.js";
import { parseInbound } from "./inbound.js";
import { WaSessionsRepo } from "./wa-sessions.repo.js";
import { OwnersRepo } from "../owners/owners.repo.js";
import { handleDriverMessage, DriverFlowDeps } from "./driver-flow.js";
import { handleCustomerMessage, CustomerFlowDeps } from "./customer-flow.js";

export function registerWaRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    sessions: WaSessionsRepo;
    ownersRepo: OwnersRepo;
    driver: DriverFlowDeps;
    customer: CustomerFlowDeps;
  },
) {
  // Interakt signs webhooks: `Interakt-Signature: sha256=` + HMAC-SHA256(rawBody).
  // Skipped when no secret is configured (dev). Interakt wants a 200 within 3s,
  // so we verify + ack, then process off the request.
  app.post("/wa/inbound", { config: { rawBody: true } }, async (req, reply) => {
    const secret = deps.config.interaktWebhookSecret;
    if (secret) {
      const sig = String(req.headers["interakt-signature"] ?? req.headers["x-interakt-signature"] ?? "");
      const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
      const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
      const a = Buffer.from(sig), b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return reply.code(401).send({ error: "bad signature" });
      }
    }
    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    reply.code(200).send({ status: "ok" });

    setImmediate(async () => {
      try {
        const session0 = null; // parseInbound only needs options for title echoes — fetch after we know `from`
        const probe = parseInbound(payload, []);
        if (!probe) return;
        const session = await deps.sessions.get(probe.from);
        const m = parseInbound(payload, session?.lastOptions ?? []);
        if (!m) return;
        // first-time senders need a session row before markProcessed can dedupe
        if (!session) {
          const owner = await deps.ownersRepo.findByPhoneDigits(m.from);
          await deps.sessions.upsert({ phone: m.from, role: owner ? "driver" : "customer", state: "IDLE" });
        }
        if (!(await deps.sessions.markProcessed(m.from, m.msgId))) return; // duplicate delivery

        const fresh = await deps.sessions.get(m.from);
        const owner = await deps.ownersRepo.findByPhoneDigits(m.from);
        if (owner || fresh?.role === "driver") await handleDriverMessage(deps.driver, m, fresh);
        else await handleCustomerMessage(deps.customer, m, fresh);
      } catch (e) {
        app.log.error({ err: e }, "[wa] inbound processing failed");
      }
    });
  });
}
```

Note: the existing `application/json` content-type parser gives a parsed object, not the raw string — for the HMAC, re-stringifying is NOT byte-faithful. Register the route on a raw-body basis instead: in `server.ts`, before `registerWaRoutes`, add a scoped parser or simply read `req.rawBody` if available. Simplest robust approach that fits the existing parser setup: register a Fastify `preParsing` hook capturing the raw payload for this one route:

```ts
// server.ts, before routes: capture raw body for HMAC verification on /wa/inbound
app.addHook("preParsing", async (req, _reply, payload) => {
  if (req.url === "/wa/inbound") {
    const chunks: Buffer[] = [];
    for await (const c of payload) chunks.push(Buffer.from(c));
    const raw = Buffer.concat(chunks);
    (req as any).rawBody = raw;
    const { Readable } = await import("node:stream");
    return Readable.from(raw);
  }
  return payload;
});
```

and in the route use `(req as any).rawBody ?? Buffer.from("")` for the HMAC input.

- [ ] **Step 4: Wire in `src/server.ts`** (after the existing route registrations; skip entirely when WA is off):

```ts
  if (interakt && waSender) {
    const availability = { quotesRepo, callsRepo, loadsRepo, demandRepo, orchestrator };
    const capture = { demandRepo, loadsRepo, ownersRepo, callsRepo, orchestrator, geo };
    registerWaRoutes(app, {
      config: deps.config,
      sessions: waSessions,
      ownersRepo,
      driver: { availability, orchestrator, interakt, sessions: waSessions, callsRepo, loadsRepo, config: deps.config },
      customer: { capture, interakt, sessions: waSessions, demandRepo, loadsRepo, parseLoad: buildLoadParser(deps.config), config: deps.config },
    });
  }
```

- [ ] **Step 5: Run** — `npx vitest run tests/wa-routes.test.ts` then FULL suite → PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(wa): /wa/inbound webhook (HMAC, async ack, idempotent) + role routing + server wiring"`

---

### Task 11: Demand routes on the WA channel (confirm / reoffer / hold)

**Files:**
- Modify: `src/demand/demand.routes.ts`, `src/calls/orchestrator.ts`
- Test: `tests/wa-domino.test.ts`

**Interfaces:**
- Consumes: `WaSender.sendOffer/sendConfirm/sendText` (Task 7), `demand.channel` (Task 9).
- Produces: `approve-driver` sends the WA confirm instead of the voice confirm when `demand.channel === "whatsapp"`; `reoffer`/`followup` on a WA-channel owner send a WA re-offer message (existing `fixed_price_followup` flow, `channel='wa'` attempt) — this already works through the orchestrator branch from Task 7, so only `approve-driver` + cancel notices change here.

- [ ] **Step 1: Failing test** — `tests/wa-domino.test.ts` (end-to-end: WA customer → WA driver → dashboard approve → WA confirm → booked):

```ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fakeInterakt } from "./wa-sender.test.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", INTERAKT_API_KEY: "ik", INTERAKT_WEBHOOK_SECRET: "sekrit",
  MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1", GOOGLE_MAPS_API_KEY: "",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };
const fakeGeo = { async resolveLocation(text: string) {
  return { raw: text, canonical: text, city: text, state: "MH", lat: 19.1, lng: 72.8, source: "test" };
} };
const sign = (b: string) => "sha256=" + crypto.createHmac("sha256", "sekrit").update(b).digest("hex");
const waMsg = (app: any, phone: string, message: any, id: string) => {
  const body = JSON.stringify({ type: "message_received",
    data: { customer: { channel_phone_number: phone, traits: { name: "X" } },
            message: { id, message_content_type: "Text", message } } });
  return app.inject({ method: "POST", url: "/wa/inbound", payload: body,
    headers: { "content-type": "application/json", "interakt-signature": sign(body) } });
};
const settle = () => new Promise((r) => setTimeout(r, 80));

describe("full WA domino", () => {
  it("customer posts on WA → WA driver accepts → approve → WA confirm → customer books", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const el = { originateCall: async () => ({ conversationId: `v${Math.random()}` }) };
    const app = buildServer({ pool, config, geo: fakeGeo as any, el: el as any, interakt: client });

    // WA-preference driver on the lane
    const owner = (await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "Ramesh", phone: "+919111111122", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }], channel: "whatsapp" } })).json();

    // customer posts a complete load in one message (LLM key unset → but all fields present via guided ids is long;
    // simplest: post the demand through the same captureDemand path the flow uses, via /webhooks/report-demand channel field is voice —
    // so instead simulate the WA confirm tap directly after a parsed draft: keep it simple and drive the guided flow)
    await waMsg(app, "+919888888811", "need a truck", "m1");
    await settle();
    // guided: from, to, vehicle (list), date (tomorrow), price, confirm
    await waMsg(app, "+919888888811", "Mumbai", "m2"); await settle();
    await waMsg(app, "+919888888811", "Pune", "m3"); await settle();
    await waMsg(app, "+919888888811", JSON.stringify({ type: "list_reply", list_reply: { id: "veh:16ft", title: "16ft" } }), "m4"); await settle();
    await waMsg(app, "+919888888811", JSON.stringify({ type: "button_reply", button_reply: { id: "date:tomorrow", title: "Tomorrow" } }), "m5"); await settle();
    await waMsg(app, "+919888888811", "13000", "m6"); await settle();
    await waMsg(app, "+919888888811", JSON.stringify({ type: "button_reply", button_reply: { id: "cfm:yes", title: "✅ Confirm" } }), "m7"); await settle();

    // demand sourced over WA: driver got a template offer
    const demands = (await app.inject({ method: "GET", url: "/demand", headers: auth })).json();
    expect(demands[0]).toMatchObject({ channel: "whatsapp", status: "SOURCING" });
    const offer = sent.find((s) => s.kind === "template" && s.to === "919111111122");
    expect(offer).toBeTruthy();
    const attemptId = (offer!.args[2]["0"][0] as string).split(":")[1]; // acc:<attemptId>:<price>

    // driver taps Accept
    await waMsg(app, "+919111111122", JSON.stringify({ type: "button_reply", button_reply: { id: `acc:${attemptId}:13000`, title: "Accept" } }), "m8");
    await settle();
    let d = (await app.inject({ method: "GET", url: `/demand/${demands[0].id}`, headers: auth })).json();
    expect(d.status).toBe("DRIVER_LOCKED");
    expect(d.lockedPriceInr).toBe(13000);

    // dispatcher approves → WA confirm goes to the customer (no voice call)
    await app.inject({ method: "POST", url: `/demand/${d.id}/approve-driver`, headers: auth });
    expect(sent.some((s) => (s.kind === "buttons" || s.kind === "template") && s.to === "919888888811" && /Book|found/i.test(String(s.args[0])))).toBe(true);

    // customer taps Confirm booking
    await waMsg(app, "+919888888811", JSON.stringify({ type: "button_reply", button_reply: { id: `bok:${d.id}`, title: "Confirm booking" } }), "m9");
    await settle();
    d = (await app.inject({ method: "GET", url: `/demand/${d.id}`, headers: auth })).json();
    expect(d.status).toBe("BOOKED");
  });
});
```

- [ ] **Step 2: Run to verify FAIL** (approve-driver still places a voice confirm call).

- [ ] **Step 3: Implement.** In `src/demand/demand.routes.ts`, the deps type gains `waSender?: WaSender` and `ownersRepo` is already there. Change the approve-driver handler:

```ts
    if (approved.loadId) {
      const load = await deps.loadsRepo.getLoad(approved.loadId);
      // Same-channel confirm: WA-intake demands get WhatsApp buttons; everything
      // else keeps the voice confirm call.
      if (approved.channel === "whatsapp" && deps.waSender && load) {
        const owners = await deps.ownersRepo.getActiveOwners();
        const winner = owners.find((o) => o.id === approved.winningOwnerId);
        await deps.waSender.sendConfirm(approved, load, winner?.name ?? "our driver");
      } else {
        await deps.orchestrator.confirmCustomer(approved.loadId, approved.customerPhone, approved.id);
      }
    }
```

In the `cancel` handler, after setting CANCELLED, add the courtesy notice:

```ts
    if (d.channel === "whatsapp" && deps.waSender) {
      await deps.waSender.sendText(d.customerPhone, "We couldn't arrange this trip — our team may call you. You can post a new load here anytime. 🙏");
    }
```

Pass `waSender` through from `server.ts` in `registerDemandRoutes(app, { ..., waSender }, preHandler)`.

- [ ] **Step 4: Run** — `npx vitest run tests/wa-domino.test.ts` then FULL suite → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(wa): same-channel booking confirm + cancel notice; full WA domino test"`

---

### Task 12: Console badges + owner channel selector

**Files:**
- Modify: `web/src/api/client.ts`, `web/src/components/TheLine.tsx`, the owners view (`web/src/views/` — locate the owners editor component), `src/loads/loads.routes.ts` only if calls listing filters fields (it returns repo rows as-is — likely no change).
- Test: `cd web && npx tsc --noEmit` (the web app has no unit tests; verify types + visual check).

**Interfaces:**
- Consumes: `call_attempts.channel` already serialized by `rowToCall` (Task 2) — the API responses carry `channel` automatically.

- [ ] **Step 1: Types.** In `web/src/api/client.ts` add to `CallAttempt`: `channel: "voice" | "wa";` — and to `Owner`/`OwnerInput`: `channel: "voice" | "whatsapp" | "both";` (optional on input). Add to `DemandRequest`: `channel: "voice" | "whatsapp" | "console";`.

- [ ] **Step 2: TheLine badge.** In `web/src/components/TheLine.tsx`, next to each row's owner name / status chip, render a small mono badge: `{c.channel === "wa" ? "💬" : "📞"}` with `title={c.channel === "wa" ? "WhatsApp" : "Call"}` (match the row's existing icon sizing; keep it one span, no new component).

- [ ] **Step 3: Owner channel selector.** In the owners editor (fleet view), add a three-way select next to the active toggle: options voice/whatsapp/both → `api.updateOwner(id, { channel })`. Follow the existing input styling (`input-dark` / panel selects).

- [ ] **Step 4: Demand card badge.** Where the Inbound board renders a demand (channel now on the payload), show `💬 WhatsApp` / `📞 Call` in the meta line.

- [ ] **Step 5: Verify** — `cd web && npx tsc --noEmit` → clean; `npm run dev` and eyeball a load with mixed-channel attempts (or rely on the docker build in Task 13).

- [ ] **Step 6: Commit** — `git commit -am "feat(web): channel badges on call rows + demand cards, owner channel selector"`

---

### Task 13: Env, docs, smoke script

**Files:**
- Modify: `.env.example`, `README.md`
- Create: `scripts/wa-smoke.ts`

- [ ] **Step 1: `.env.example`** — append:

```bash
# --- WhatsApp channel (Interakt) ---
# API key from Interakt dashboard (Basic auth token). WA channel is off without it.
INTERAKT_API_KEY=
# "Verify token" from the Interakt webhook config — signs inbound webhooks.
INTERAKT_WEBHOOK_SECRET=
INTERAKT_COUNTRY_CODE=+91
WA_ENABLED=true
# minutes before an unanswered WhatsApp offer is closed as NO_ANSWER
WA_REPLY_TTL_MIN=30
# free-text load parsing for WhatsApp intake (optional; guided flow without it)
GROQ_API_KEY=
GROQ_MODEL=llama-3.3-70b-versatile
```

- [ ] **Step 2: README** — add a "WhatsApp channel" subsection under Architecture: Interakt webhook → `POST /wa/inbound`; per-owner `channel`; offers are `call_attempts` with `channel='wa'`; the three required templates (`sourcing_offer`, `sourcing_confirm`, `sourcing_update`) and the 24h-window rule; setup steps (point Interakt webhook at `https://<PUBLIC_DOMAIN>/wa/inbound`, set the two secrets, approve templates).

- [ ] **Step 3: `scripts/wa-smoke.ts`** — a tiny live-send check (run manually, never in CI):

```ts
// Live smoke: sends one text + one button message to the phone in argv[2].
//   npx tsx scripts/wa-smoke.ts 919888888888
import { loadConfig } from "../src/config.js";
import { buildInteraktClient } from "../src/wa/interakt.client.js";

const to = process.argv[2];
if (!to) throw new Error("usage: npx tsx scripts/wa-smoke.ts <digits>");
const client = buildInteraktClient(loadConfig());
await client.sendText(to, "wa-smoke: text OK");
await client.sendButtons(to, "wa-smoke: pick one", [
  { id: "smoke:a", title: "Option A" },
  { id: "smoke:b", title: "Option B" },
]);
console.log("sent — check the phone");
```

- [ ] **Step 4: Full suite + build** — `npx vitest run && npm run build` → PASS/clean.

- [ ] **Step 5: Commit** — `git commit -am "docs(wa): env example, README channel section, live smoke script"`

---

## Deployment notes (post-merge, user-owned steps included)

1. Copy `INTERAKT_API_KEY` (+ set a webhook secret) from `Support-service.env` into the OVH `.env`; `docker compose up -d --build app`.
2. In Interakt: remove the support-service webhook, point webhooks at `https://<PUBLIC_DOMAIN>/wa/inbound` with the same verify token.
3. Create + submit the three templates; until `sourcing_offer` is approved, WA-preference owners transparently fall back to voice calls.
4. Verify with `npx tsx scripts/wa-smoke.ts <your number>` on the box, then a live guided intake from a personal WhatsApp.

## Self-review notes

- Spec coverage: intake (T9), driver offer/counter/no (T7/T8), same-channel confirm (T7/T11), per-owner channel (T2/T7), filled-notices (T7/T8), watchdog TTL (T2), templates + fallback (T7), dashboard (T12), env/docs/smoke (T13), idempotency + HMAC (T5/T10). Re-offer/hold ride the existing reoffer/followup routes through the orchestrator's channel branch (T7) — no extra route work.
- Known ceiling (`ponytail:` markers in code): owner channel `'both'` behaves as `'whatsapp'`+failure-fallback in v1; voice-after-TTL escalation is a later add. `cfm:edit` restarts the draft rather than field-level editing.
- Interakt template-send body shape (`template: { name, languageCode, bodyValues, buttonValues }`) must be verified against the Interakt docs/dashboard during Task 13's smoke test — it's isolated inside `interakt.client.ts:sendTemplate` if the field names differ.
