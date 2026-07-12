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
import { LrsRepo } from "../src/lr/lrs.repo.js";
import { DocsRepo } from "../src/lr/docs.repo.js";
import { VisionClient, VisionDoc } from "../src/wa/vision.js";
import { fakeInterakt } from "./helpers/wa.js";

// Canned vision result stub — merges sane defaults with the per-test overrides.
function fakeVision(result: { ok: true; doc: Partial<VisionDoc> } | { ok: false; reason: string }): VisionClient {
  const doc: VisionDoc = {
    docType: "lr", lrNumber: null, billedTotalInr: null, vehicleNo: null, from: null, to: null,
    docDate: null, paidStampSeen: false, confidence: 0.9,
    ...(result.ok ? result.doc : {}),
  };
  return { async extract() { return result.ok ? { ok: true, doc } : result; } };
}

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", INTERAKT_API_KEY: "ik",
} as NodeJS.ProcessEnv);

// vision: when supplied, deps.docs is wired up too (proves ordering + wiring
// without disturbing the many tests that don't touch the doc pipeline at all).
async function setup(pool: any, vision?: VisionClient) {
  const owners = new OwnersRepo(pool), loads = new LoadsRepo(pool), calls = new CallsRepo(pool);
  const quotes = new QuotesRepo(pool), demand = new DemandRepo(pool), sessions = new WaSessionsRepo(pool);
  const lrs = new LrsRepo(pool), docs = new DocsRepo(pool);
  const owner = await owners.createOwner({ name: "R", phone: "+919111111155", vehicleTypes: ["16ft"], lanes: [], channel: "whatsapp" } as any);
  const load = await loads.createLoad({ fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" });
  await loads.setStatus(load.id, "CALLING");
  const attempt = await calls.create({ loadId: load.id, ownerId: owner.id, phone: owner.phone, flow: "offer", channel: "wa" });
  await calls.setConversationId(attempt.id, `wa_${attempt.id}`);
  await calls.setStatus(attempt.id, "IN_PROGRESS");
  const { client, sent } = fakeInterakt();
  let filled = 0;
  const deps: any = {
    availability: {
      quotesRepo: quotes, callsRepo: calls, loadsRepo: loads, demandRepo: demand,
      orchestrator: { notifyFilled: async () => { filled++; } },
    },
    interakt: client, sessions, callsRepo: calls, loadsRepo: loads, config,
  };
  if (vision) {
    deps.docs = { vision, lrsRepo: lrs, docsRepo: docs, loadsRepo: loads, demandRepo: demand, interakt: client, sessions, config };
  }
  return { deps, sent, owner, load, attempt, calls, quotes, sessions, lrs, docs, getFilled: () => filled };
}
const msg = (from: string, over: any) => ({ from, msgId: `m${Math.random()}`, contactName: "R", ...over });

describe("driver flow", () => {
  it("accept locks the load and confirms to the driver", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, load, attempt, calls, getFilled } = await setup(pool);
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "reply", replyId: `acc:${attempt.id}:13000` }) as any, null);
    expect((await calls.getById(attempt.id))!.status).toBe("DONE");
    const { LoadsRepo } = await import("../src/loads/loads.repo.js");
    expect((await new LoadsRepo(pool).getLoad(load.id))!.status).toBe("LOCKED");
    expect(sent.some((s) => s.kind === "text" && /yours/i.test(s.args[0]))).toBe(true);
    expect(getFilled()).toBe(1);
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

describe("accept after counter", () => {
  it("upgrades the quote to accepts_fixed and locks the load", async () => {
    const { pool } = await withTestDb();
    const { deps, attempt, quotes, load } = await setup(pool);
    // driver counters first
    const session = { phone: "919111111155", role: "driver", state: "AWAIT_PRICE", ctx: { attemptId: attempt.id }, lastOptions: [] };
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "text", text: "14000" }) as any, session as any);
    let qs = await quotes.listByLoad(load.id);
    expect(qs[0]).toMatchObject({ acceptsFixed: false, quotedPriceInr: 14000 });
    // then taps Accept on the original offer
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "reply", replyId: `acc:${attempt.id}:13000` }) as any, null);
    qs = await quotes.listByLoad(load.id);
    expect(qs[0].acceptsFixed).toBe(true);
    const { LoadsRepo } = await import("../src/loads/loads.repo.js");
    expect((await new LoadsRepo(pool).getLoad(load.id))!.status).toBe("LOCKED");
  });
});

describe("typed answers on a live offer", () => {
  it('"haan" accepts and locks', async () => {
    const { pool } = await withTestDb();
    const { deps, sent, load, calls } = await setup(pool);
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "text", text: "haan chalega" }) as any, null);
    const { LoadsRepo } = await import("../src/loads/loads.repo.js");
    expect((await new LoadsRepo(pool).getLoad(load.id))!.status).toBe("LOCKED");
    expect(sent.some((s) => s.kind === "text" && /yours/i.test(s.args[0]))).toBe(true);
  });

  it('"haan" STILL accepts when docs deps are present (live-offer intents beat typed-LR fallback)', async () => {
    const { pool } = await withTestDb();
    const { deps, sent, load, owner } = await setup(pool, fakeVision({ ok: false, reason: "unused" }));
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "text", text: "haan chalega" }) as any, null, owner as any);
    const { LoadsRepo } = await import("../src/loads/loads.repo.js");
    expect((await new LoadsRepo(pool).getLoad(load.id))!.status).toBe("LOCKED");
    expect(sent.some((s) => s.kind === "text" && /yours/i.test(s.args[0]))).toBe(true);
  });

  it('"15 hazar" records a counter', async () => {
    const { pool } = await withTestDb();
    const { deps, quotes, load } = await setup(pool);
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "text", text: "15 hazar milega to karunga" }) as any, null);
    const qs = await quotes.listByLoad(load.id);
    expect(qs[0]).toMatchObject({ available: "YES", acceptsFixed: false, quotedPriceInr: 15000 });
  });

  it('"nahi" declines', async () => {
    const { pool } = await withTestDb();
    const { deps, quotes, load } = await setup(pool);
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "text", text: "nahi bhai busy hu" }) as any, null);
    const qs = await quotes.listByLoad(load.id);
    expect(qs[0].available).toBe("NO");
  });

  it("gibberish re-shows the offer buttons instead of the greeting", async () => {
    const { pool } = await withTestDb();
    const { deps, sent } = await setup(pool);
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "text", text: "kaunsa route hai bhai?" }) as any, null);
    const btns = sent.filter((s) => s.kind === "buttons");
    expect(btns).toHaveLength(1);
    expect(btns[0].args[1].map((b: any) => b.id.split(":")[0])).toEqual(["acc", "ctr", "no"]);
  });
});

describe("document pipeline wiring", () => {
  it("media message with docs deps routes through handleDriverMedia (ordering: media before typed-LR/greeting)", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, owner, load, lrs, calls, attempt } = await setup(
      pool, fakeVision({ ok: true, doc: { lrNumber: "PIN-A1A1A1" } }),
    );
    await calls.setStatus(attempt.id, "DONE", { ended: true }); // no live offer in the way
    await lrs.create({ lrNumber: "PIN-A1A1A1", loadId: load.id, ownerId: owner.id });
    await handleDriverMessage(
      deps as any,
      msg("919111111155", { kind: "media", mediaUrl: "https://media.example/lr.jpg" }) as any,
      null, owner as any,
    );
    expect(sent.some((s) => s.kind === "text" && /PIN-A1A1A1.*UNPAID/.test(s.args[0]))).toBe(true);
  });

  it("typed LR number with no live offer falls back to the doc lookup", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, owner, load, lrs, calls, attempt } = await setup(
      pool, fakeVision({ ok: false, reason: "unused" }),
    );
    await calls.setStatus(attempt.id, "DONE", { ended: true });
    await lrs.create({ lrNumber: "PIN-4K7KQ2", loadId: load.id, ownerId: owner.id });
    await handleDriverMessage(
      deps as any,
      msg("919111111155", { kind: "text", text: "PIN-4K7KQ2" }) as any,
      null, owner as any,
    );
    expect(sent.some((s) => s.kind === "text" && /PIN-4K7KQ2.*UNPAID/.test(s.args[0]))).toBe(true);
  });

  it("typed amount resumes an invoice compare after a NO_TOTAL ask (AWAIT_INVOICE_AMOUNT before AWAIT_PRICE)", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, owner, load, lrs, calls, attempt } = await setup(
      pool, fakeVision({ ok: true, doc: { docType: "invoice", lrNumber: "PIN-B2B2B2", billedTotalInr: null } }),
    );
    await calls.setStatus(attempt.id, "DONE", { ended: true });
    await lrs.create({ lrNumber: "PIN-B2B2B2", loadId: load.id, ownerId: owner.id }); // load's fixedPriceInr is 13000
    await handleDriverMessage(
      deps as any,
      msg("919111111155", { kind: "media", mediaUrl: "https://media.example/inv.jpg" }) as any,
      null, owner as any,
    );
    expect(sent[0].args[0]).toMatch(/type the amount/);
    const session = await deps.sessions.get("919111111155");
    expect(session?.state).toBe("AWAIT_INVOICE_AMOUNT");

    // unparseable reply re-asks and keeps the state
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "text", text: "not sure" }) as any, session as any, owner as any);
    expect(sent[1].args[0]).toMatch(/Please reply with just the amount/);

    // typed amount matching the agreed price resumes the compare
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "text", text: "13000" }) as any, session as any, owner as any);
    expect(sent[2].args[0]).toMatch(/matches the agreed freight/);
  });
});
