import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";
import { CallsRepo } from "../src/calls/calls.repo.js";
import { QuotesRepo } from "../src/quotes/quotes.repo.js";
import { DemandRepo } from "../src/demand/demand.repo.js";
import { LrsRepo } from "../src/lr/lrs.repo.js";
import { DocsRepo } from "../src/lr/docs.repo.js";
import { EmailSessionsRepo } from "../src/email/email-sessions.repo.js";
import { CallOrchestrator } from "../src/calls/orchestrator.js";
import { buildEmailRouter } from "../src/email/router.js";
import { Mailer } from "../src/email/mailer.js";
import { EmailMsg } from "../src/email/inbound.js";
import { VisionClient, VisionDoc } from "../src/wa/vision.js";
import { ParsedLoad } from "../src/wa/llm-parse.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };

const fakeGeo = {
  async resolveLocation(text: string) {
    return { raw: text, canonical: text, city: text, state: "MH", lat: 19.1, lng: 72.8, source: "none" as const };
  },
};

function fakeMailer() {
  const sent: { to: string; subject: string; text: string }[] = [];
  const mailer: Mailer = {
    async send(to, subject, text) {
      sent.push({ to, subject, text });
      return true;
    },
  };
  return { mailer, sent };
}

function fakeVision(result: { ok: true; doc: Partial<VisionDoc> } | { ok: false; reason: string }): VisionClient {
  const doc: VisionDoc = {
    docType: "lr", lrNumber: null, billedTotalInr: null, vehicleNo: null, from: null, to: null,
    docDate: null, paidStampSeen: false, confidence: 0.9,
    ...(result.ok ? result.doc : {}),
  };
  return {
    async extract() { return result.ok ? { ok: true, doc } : result; },
    async extractFromBuffer() { return result.ok ? { ok: true, doc } : result; },
  };
}

async function setup(pool: any, vision?: VisionClient) {
  const owners = new OwnersRepo(pool), loads = new LoadsRepo(pool), calls = new CallsRepo(pool);
  const quotes = new QuotesRepo(pool), demand = new DemandRepo(pool), sessions = new EmailSessionsRepo(pool);
  const lrs = new LrsRepo(pool), docs = new DocsRepo(pool);
  const el = { originateCall: async () => ({ conversationId: `c${Math.random()}` }) };
  const orchestrator = new CallOrchestrator({ pool, config, el: el as any, ownersRepo: owners, loadsRepo: loads, callsRepo: calls });
  const { mailer, sent } = fakeMailer();
  const availability = { quotesRepo: quotes, callsRepo: calls, loadsRepo: loads, demandRepo: demand, orchestrator };
  const capture = { demandRepo: demand, loadsRepo: loads, ownersRepo: owners, callsRepo: calls, orchestrator, geo: fakeGeo };
  let parseLoad: (t: string, today: string) => Promise<ParsedLoad> = async () =>
    ({ fromText: null, toText: null, vehicleType: null, priceInr: null, pickupDate: null });
  const docsDeps = vision ? { vision, lrsRepo: lrs, docsRepo: docs, loadsRepo: loads, demandRepo: demand, config } : undefined;
  const router = buildEmailRouter({
    sessions,
    ownersRepo: owners,
    driver: { availability, callsRepo: calls, loadsRepo: loads, config, mailer, sessions, docs: docsDeps },
    customer: {
      capture, mailer, sessions, demandRepo: demand, loadsRepo: loads, config,
      parseLoad: (t, today) => parseLoad(t, today),
    },
    config,
  });
  return {
    router, mailer, sent, owners, loads, calls, quotes, demand, sessions, lrs, docs,
    setParseLoad: (fn: typeof parseLoad) => { parseLoad = fn; },
  };
}

const msg = (from: string, over: Partial<EmailMsg>): EmailMsg => ({
  from, messageId: `<m${Math.random()}@x.com>`, subject: "Load", text: "",
  attachments: [], tags: {}, autoReply: false, ...over,
});

describe("email customer flow", () => {
  it("partial → collecting → complete → yes posts the load, channel email, SOURCING", async () => {
    const { pool } = await withTestDb();
    const s = await setup(pool);
    await s.owners.createOwner({ name: "D", phone: "+919111144411", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }] } as any);

    let calls = 0;
    s.setParseLoad(async () => {
      calls++;
      return calls === 1
        ? { fromText: "Mumbai", toText: "Pune", vehicleType: null, priceInr: null, pickupDate: null }
        : { fromText: null, toText: null, vehicleType: "16ft", priceInr: 13000, pickupDate: "2026-07-05" };
    });

    await s.router.handle(msg("cust@example.com", { text: "mumbai to pune please" }));
    expect(s.sent.some((x) => /missing details/i.test(x.text))).toBe(true);
    let session = await s.sessions.get("cust@example.com");
    expect(session!.state).toBe("COLLECTING");

    await s.router.handle(msg("cust@example.com", { text: "16ft, 13000, 5 july" }));
    session = await s.sessions.get("cust@example.com");
    expect(session!.state).toBe("CONFIRM");
    expect(s.sent[s.sent.length - 1].text).toMatch(/Mumbai → Pune/);
    expect(s.sent[s.sent.length - 1].text).toMatch(/Reply YES to post this load/);

    await s.router.handle(msg("cust@example.com", { text: "yes" }));
    const demands = await s.demand.list();
    expect(demands[0]).toMatchObject({ channel: "email", status: "SOURCING", offeredPriceInr: 13000, customerPhone: "cust@example.com" });
    expect(demands[0].elConversationId).toMatch(/^em_/);
    expect(s.sent[s.sent.length - 1].text).toMatch(/truck/i);
  });

  it("unknown sender + gibberish → walkthrough email with an example + the missing-fields list", async () => {
    const { pool } = await withTestDb();
    const { router, sent } = await setup(pool);
    await router.handle(msg("nobody@example.com", { text: "asdkjfh qwoeiru random words here" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/Tell us your load/i);
    expect(sent[0].text).toMatch(/missing details/i);
  });
});

describe("email driver flow", () => {
  async function seedOfferedAttempt(pool: any) {
    const { owners, loads, calls } = await setupRepos(pool);
    const owner = await owners.createOwner({
      name: "R", phone: "+919111100022", vehicleTypes: ["16ft"], lanes: [], channel: "email", email: "driver@example.com",
    } as any);
    const load = await loads.createLoad({ fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" });
    await loads.setStatus(load.id, "CALLING");
    const attempt = await calls.create({ loadId: load.id, ownerId: owner.id, phone: owner.phone, flow: "offer", channel: "email" });
    // em_<id> is exactly what email-sender.ts's real sendOffer sets — exercising the
    // actions.ts cid fix (it used to hardcode wa_<id> and would silently no-op here).
    await calls.setConversationId(attempt.id, `em_${attempt.id}`);
    await calls.setStatus(attempt.id, "IN_PROGRESS");
    return { owner, load, attempt, owners, loads, calls };
  }
  async function setupRepos(pool: any) {
    return { owners: new OwnersRepo(pool), loads: new LoadsRepo(pool), calls: new CallsRepo(pool) };
  }

  it('typed "yes" with an ATT- subject tag accepts and locks the load', async () => {
    const { pool } = await withTestDb();
    const { router, sent } = await setup(pool);
    const { owner, load, attempt } = await seedOfferedAttempt(pool);

    await router.handle(msg("driver@example.com", {
      subject: `New load [ATT-${attempt.id}]`, text: "yes", tags: { attempt: attempt.id },
    }));

    const { LoadsRepo: LR } = await import("../src/loads/loads.repo.js");
    expect((await new LR(pool).getLoad(load.id))!.status).toBe("LOCKED");
    expect(sent.some((s) => /yours/i.test(s.text))).toBe(true);
    const { CallsRepo: CR } = await import("../src/calls/calls.repo.js");
    expect((await new CR(pool).getById(attempt.id))!.status).toBe("DONE");
  });

  it('"16 hazar" with no subject tag falls back to the newest live email attempt and records a counter', async () => {
    const { pool } = await withTestDb();
    const { router, sent } = await setup(pool);
    const { owner } = await seedOfferedAttempt(pool);
    const quotes = new QuotesRepo(pool);

    await router.handle(msg("driver@example.com", { text: "16 hazar milega to theek hai" }));
    const qs = await quotes.listByLoad((await new LoadsRepo(pool).listLoads())[0].id);
    expect(qs[0]).toMatchObject({ available: "YES", acceptsFixed: false, quotedPriceInr: 16000 });
    expect(sent.some((s) => /16,000/.test(s.text))).toBe(true);
  });

  it("attachment LR status via a stubbed vision buffer, sourceRef = email:<messageId>/<filename>", async () => {
    const { pool } = await withTestDb();
    const vision = fakeVision({ ok: true, doc: { lrNumber: "PIN-4K7KQ2" } });
    const { router, sent, docs } = await setup(pool, vision);
    const { owner, load, calls, attempt } = await seedOfferedAttempt(pool);
    await calls.setStatus(attempt.id, "DONE", { ended: true }); // no live offer in the way
    const lrs = new LrsRepo(pool);
    await lrs.create({ lrNumber: "PIN-4K7KQ2", loadId: load.id, ownerId: owner.id });

    await router.handle(msg("driver@example.com", {
      messageId: "<msg-77@x.com>",
      attachments: [{ buffer: Buffer.from([1, 2, 3]), mime: "image/jpeg", filename: "lr.jpg" }],
    }));

    expect(sent.some((s) => /PIN-4K7KQ2.*UNPAID/s.test(s.text))).toBe(true);
    const rows = await docs.listByLoad(load.id);
    expect(rows[0].mediaUrl).toBe("email:<msg-77@x.com>/lr.jpg");
  });

  it("invoice with no resolvable LR ref guesses the driver's latest BOOKED load and asks YES/NO; YES links + scores it", async () => {
    const { pool } = await withTestDb();
    const vision = fakeVision({ ok: true, doc: { docType: "invoice", lrNumber: null, billedTotalInr: 14000 } });
    const { router, sent, sessions, docs } = await setup(pool, vision);
    const { owners, loads, calls } = await setupRepos(pool);
    const owner = await owners.createOwner({ name: "R2", phone: "+919111100033", vehicleTypes: ["16ft"], lanes: [], channel: "email", email: "inv@example.com" } as any);
    const load = await loads.createLoad({ fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 14000, createdBy: "t" });
    await loads.setStatus(load.id, "BOOKED");
    const demand = new DemandRepo(pool);
    const { demand: d } = await demand.upsertByConversation({ customerPhone: "+919888800001", fromText: "Mumbai", toText: "Pune", elConversationId: "conv_x1" } as any);
    await demand.setStatus(d.id, "SOURCING");
    await demand.attachLoad(d.id, load.id);
    await demand.lockDriver(load.id, owner.id, 14000);

    await router.handle(msg("inv@example.com", { attachments: [{ buffer: Buffer.from([1]), mime: "image/jpeg", filename: "inv.jpg" }] }));
    expect(sent[0].text).toMatch(/Is this invoice for Mumbai→Pune · ₹14,000\? Reply YES or NO\./);
    let session = await sessions.get("inv@example.com");
    expect(session!.state).toBe("CONFIRM_INVOICE_TRIP");

    await router.handle(msg("inv@example.com", { text: "yes" }));
    expect(sent[1].text).toMatch(/matches the agreed freight/);
    session = await sessions.get("inv@example.com");
    expect(session!.state).toBe("IDLE");
    const docRows = await docs.listByLoad(load.id);
    expect(docRows[0]).toMatchObject({ dispute: "NONE", varianceInr: 0 });
  });

  it("invoice with an unreadable total asks to type the amount; a typed number resumes the compare", async () => {
    const { pool } = await withTestDb();
    const vision = fakeVision({ ok: true, doc: { docType: "invoice", lrNumber: "PIN-9Z9Z9Z", billedTotalInr: null } });
    const { router, sent, sessions } = await setup(pool, vision);
    const { owners, loads } = await setupRepos(pool);
    const owner = await owners.createOwner({ name: "R3", phone: "+919111100044", vehicleTypes: ["16ft"], lanes: [], channel: "email", email: "amt@example.com" } as any);
    const load = await loads.createLoad({ fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" });
    const lrs = new LrsRepo(pool);
    await lrs.create({ lrNumber: "PIN-9Z9Z9Z", loadId: load.id, ownerId: owner.id });

    await router.handle(msg("amt@example.com", { attachments: [{ buffer: Buffer.from([1]), mime: "image/jpeg", filename: "inv2.jpg" }] }));
    expect(sent[0].text).toMatch(/type the amount/);
    let session = await sessions.get("amt@example.com");
    expect(session!.state).toBe("AWAIT_INVOICE_AMOUNT");

    await router.handle(msg("amt@example.com", { text: "13000" }));
    expect(sent[1].text).toMatch(/matches the agreed freight/);
    session = await sessions.get("amt@example.com");
    expect(session!.state).toBe("IDLE");
  });

  it("no live offer and no LR-shaped text → the driver walkthrough email", async () => {
    const { pool } = await withTestDb();
    const { router, sent } = await setup(pool);
    const { calls, attempt } = await seedOfferedAttempt(pool);
    await calls.setStatus(attempt.id, "DONE", { ended: true }); // no live offer
    await router.handle(msg("driver@example.com", { text: "kuch samajh nahi aaya" }));
    expect(sent[0].text).toMatch(/booking assistant/i);
    expect(sent[0].text).toMatch(/LR \/ bilty status/i);
  });
});

describe("router hygiene", () => {
  it("autoReply messages are skipped entirely", async () => {
    const { pool } = await withTestDb();
    const { router, sent } = await setup(pool);
    await router.handle(msg("no-reply@carrier.com", { text: "Out of office", autoReply: true }));
    expect(sent).toHaveLength(0);
  });

  it("a redelivered messageId is deduped — processed only once", async () => {
    const { pool } = await withTestDb();
    const { router, sent } = await setup(pool);
    const fixed = msg("dup@example.com", { messageId: "<same@x.com>", text: "asdkjfh gibberish" });
    await router.handle(fixed);
    await router.handle(fixed);
    expect(sent).toHaveLength(1);
  });

  it("a message from our own configured smtpUser address is dropped as a self-loop — no session, no reply", async () => {
    const { pool } = await withTestDb();
    const selfConfig = loadConfig({
      DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
      PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
      ELEVENLABS_SIP_PHONE_ID: "p", MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1",
      SMTP_USER: "shared@ourbox.com",
    } as NodeJS.ProcessEnv);
    const owners = new OwnersRepo(pool);
    const sessions = new EmailSessionsRepo(pool);
    const { mailer, sent } = fakeMailer();
    // driver/customer deps are never touched if the guard fires first — leaving
    // them empty makes the test fail loudly (throw) if the guard regresses.
    const router = buildEmailRouter({
      sessions,
      ownersRepo: owners,
      driver: {} as any,
      customer: {} as any,
      config: selfConfig,
    });

    await router.handle(msg("shared@ourbox.com", { text: "BCC of our own outbound offer" }));

    expect(sent).toHaveLength(0);
    expect(await sessions.get("shared@ourbox.com")).toBeNull();
  });
});

describe("approve-driver: email-channel customer confirm", () => {
  it("an email-channel demand at DRIVER_LOCKED gets a Confirm booking email on approve-driver, no voice call placed", async () => {
    const { pool } = await withTestDb();
    const { mailer, sent } = fakeMailer();
    const placed: any[] = [];
    const el = { originateCall: async (a: any) => { placed.push(a); return { conversationId: `c${placed.length}` }; } };
    const app = buildServer({ pool, config, el: el as any, mailer });

    const ownersRepo = new OwnersRepo(pool);
    const loadsRepo = new LoadsRepo(pool);
    const demandRepo = new DemandRepo(pool);

    const owner = await ownersRepo.createOwner({
      name: "Driver E", phone: "+919111100055", vehicleTypes: ["16ft"], lanes: [],
      channel: "email", email: "driver3@example.com",
    } as any);
    const load = await loadsRepo.createLoad({
      fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft",
      pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t",
    });

    const { demand } = await demandRepo.upsertByConversation({
      customerPhone: "customer@example.com", fromText: "Mumbai", toText: "Pune",
      elConversationId: "em_approve_test_1", channel: "email",
    });
    await demandRepo.setStatus(demand.id, "SOURCING");
    await demandRepo.attachLoad(demand.id, load.id);
    await demandRepo.lockDriver(load.id, owner.id, 13000);

    const res = await app.inject({ method: "POST", url: `/demand/${demand.id}/approve-driver`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "CUSTOMER_PENDING" });

    expect(placed).toHaveLength(0); // no voice call — stayed on email
    const confirmMail = sent.find((s) => s.to === "customer@example.com" && /Confirm booking \[DMD-/.test(s.subject));
    expect(confirmMail).toBeTruthy();
  });
});
