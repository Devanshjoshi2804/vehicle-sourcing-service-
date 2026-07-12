import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { fakeInterakt } from "./helpers/wa.js";
import { loadConfig } from "../src/config.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";
import { LrsRepo } from "../src/lr/lrs.repo.js";
import { DocsRepo } from "../src/lr/docs.repo.js";
import { DemandRepo } from "../src/demand/demand.repo.js";
import { WaSessionsRepo } from "../src/wa/wa-sessions.repo.js";
import { VisionClient, VisionDoc } from "../src/wa/vision.js";
import { WaInbound } from "../src/wa/inbound.js";
import { Owner } from "../src/owners/owners.schema.js";
import { DocFlowDeps, handleDriverMedia, handleTypedLr, normalizeLrNumber, looksLikeLrNumber } from "../src/wa/doc-flow.js";

const testConfig = () =>
  loadConfig({
    DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
    PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
    ELEVENLABS_SIP_PHONE_ID: "p", INTERAKT_API_KEY: "ik",
  } as NodeJS.ProcessEnv);

const digits = (phone: string) => phone.replace(/\D/g, "");

// Canned vision result stub — merges sane defaults with the per-test overrides.
function fakeVision(result: { ok: true; doc: Partial<VisionDoc> } | { ok: false; reason: string }): VisionClient {
  const doc: VisionDoc = {
    docType: "lr", lrNumber: null, billedTotalInr: null, vehicleNo: null, from: null, to: null,
    docDate: null, paidStampSeen: false, confidence: 0.9,
    ...(result.ok ? result.doc : {}),
  };
  return { async extract() { return result.ok ? { ok: true, doc } : result; } };
}

async function seed(pool: any) {
  const owners = new OwnersRepo(pool);
  const loads = new LoadsRepo(pool);
  const lrs = new LrsRepo(pool);
  const docs = new DocsRepo(pool);
  const demand = new DemandRepo(pool);
  const sessions = new WaSessionsRepo(pool);

  const owner = await owners.createOwner({
    name: "Ramesh", phone: "+919111100011", vehicleTypes: ["16ft"],
    lanes: [{ from: "Mumbai", to: "Pune" }], channel: "whatsapp",
  } as any);
  const load = await loads.createLoad({
    fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft",
    pickupDate: "2026-07-10", fixedPriceInr: 14000, createdBy: "t",
  });
  await loads.setStatus(load.id, "BOOKED");
  const lr = await lrs.create({ lrNumber: "PIN-4K7KQ2", loadId: load.id, ownerId: owner.id });

  return { owners, loads, lrs, docs, demand, sessions, owner, load, lr };
}

function mediaMsg(phone: string, msgId: string, mediaUrl = "https://media.example/1.jpg"): WaInbound {
  return { from: digits(phone), msgId, kind: "media", mediaUrl, contactName: "R" };
}

function depsFor(
  s: Awaited<ReturnType<typeof seed>>,
  vision: VisionClient,
  client: ReturnType<typeof fakeInterakt>["client"],
  config = testConfig(),
): DocFlowDeps {
  return {
    vision, lrsRepo: s.lrs, docsRepo: s.docs, loadsRepo: s.loads, demandRepo: s.demand,
    interakt: client, sessions: s.sessions, config,
  };
}

// driver_docs rows with no lr/load (unprocessed/other) aren't reachable via
// listByLoad — look them up directly for assertions.
async function latestDocFor(pool: any, phone: string) {
  const { rows } = await pool.query(
    `SELECT * FROM driver_docs WHERE phone=$1 ORDER BY created_at DESC LIMIT 1`,
    [phone],
  );
  return rows[0];
}

describe("doc-flow: normalizeLrNumber / looksLikeLrNumber", () => {
  it("uppercases, strips spaces, collapses dashes, maps O/I to 0/1 only in the PIN- tail", () => {
    expect(normalizeLrNumber("pin-4k7kq2")).toBe("PIN-4K7KQ2");
    expect(normalizeLrNumber("PIN - 4K7KQ2")).toBe("PIN-4K7KQ2");
    expect(normalizeLrNumber("PIN--4K7KQ2")).toBe("PIN-4K7KQ2");
    expect(normalizeLrNumber("PIN-4K7KO2")).toBe("PIN-4K7K02");
    expect(normalizeLrNumber("PIN-I2I2I2")).toBe("PIN-121212");
    expect(normalizeLrNumber("b0817")).toBe("B0817"); // foreign number: no O/I remap
  });

  it("looksLikeLrNumber requires a digit and the LR shape", () => {
    expect(looksLikeLrNumber("PIN-4K7KQ2")).toBe(true);
    expect(looksLikeLrNumber("B0817")).toBe(true);
    expect(looksLikeLrNumber("HAAN")).toBe(false);
    expect(looksLikeLrNumber("NAHI")).toBe(false);
  });
});

describe("doc-flow: LR branch", () => {
  it("1. ours+mine UNPAID → status reply, doc row upserted kind lr", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    const { client, sent } = fakeInterakt();
    const d = depsFor(s, fakeVision({ ok: true, doc: { lrNumber: "PIN-4K7KQ2" } }), client);
    await handleDriverMedia(d, mediaMsg(s.owner.phone, "m1"), s.owner);
    expect(sent[0].args[0]).toMatch(/PIN-4K7KQ2.*UNPAID/);
    const rows = await s.docs.listByLoad(s.load.id);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("lr");
  });

  it("2. ours+mine PAID → reply matches PAID on <date>", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    await s.lrs.markPaid(s.lr.id);
    const { client, sent } = fakeInterakt();
    const d = depsFor(s, fakeVision({ ok: true, doc: { lrNumber: "PIN-4K7KQ2" } }), client);
    await handleDriverMedia(d, mediaMsg(s.owner.phone, "m2"), s.owner);
    expect(sent[0].args[0]).toMatch(/PAID on/);
    expect(sent[0].args[0]).not.toMatch(/UNPAID/);
  });

  it("3. ours+other driver → different-vehicle reply, lr flagged needs_review + note", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    const other = await s.owners.createOwner({
      name: "Other", phone: "+919111100099", vehicleTypes: ["16ft"], lanes: [], channel: "whatsapp",
    } as any);
    const { client, sent } = fakeInterakt();
    const d = depsFor(s, fakeVision({ ok: true, doc: { lrNumber: "PIN-4K7KQ2" } }), client);
    await handleDriverMedia(d, mediaMsg(other.phone, "m3"), other as Owner);
    expect(sent[0].args[0]).toMatch(/different vehicle/);
    const updated = await s.lrs.getById(s.lr.id);
    expect(updated!.needsReview).toBe(true);
    expect(updated!.note).toContain("wrong-driver claim");
    const doc = await latestDocFor(pool, digits(other.phone));
    expect(doc.dispute).toBe("NONE");
  });

  it("4. ours unmapped + uploader IS demand winner → mapped, status reply", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    const winner = await s.owners.createOwner({
      name: "Winner", phone: "+919111100077", vehicleTypes: ["16ft"], lanes: [], channel: "whatsapp",
    } as any);
    const load2 = await s.loads.createLoad({
      fromLocation: "Delhi", toLocation: "Jaipur", vehicleType: "16ft",
      pickupDate: "2026-07-11", fixedPriceInr: 9000, createdBy: "t",
    });
    await s.loads.setStatus(load2.id, "BOOKED");
    const lr2 = await s.lrs.create({ lrNumber: "PIN-9Z9Z9Z", loadId: load2.id, ownerId: null });

    const { demand: dem } = await s.demand.upsertByConversation({
      customerPhone: "+919888800000", fromText: "Delhi", toText: "Jaipur", elConversationId: "conv_t4",
    });
    await s.demand.setStatus(dem.id, "SOURCING");
    await s.demand.attachLoad(dem.id, load2.id);
    await s.demand.lockDriver(load2.id, winner.id, 9000);

    const { client, sent } = fakeInterakt();
    const d = depsFor(s, fakeVision({ ok: true, doc: { lrNumber: "PIN-9Z9Z9Z" } }), client);
    await handleDriverMedia(d, mediaMsg(winner.phone, "m4"), winner as Owner);

    expect(sent[0].args[0]).toMatch(/UNPAID/);
    const updated = await s.lrs.getById(lr2.id);
    expect(updated!.ownerId).toBe(winner.id);
  });

  it("5. PIN-shaped, not found exactly, fuzzy distance-1 hit → status reply for the real LR", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    const { client, sent } = fakeInterakt();
    // vision misreads the 'Q' as an 'O' — normalizes to 4K7K02 vs the real 4K7KQ2 (distance 1)
    const d = depsFor(s, fakeVision({ ok: true, doc: { lrNumber: "PIN-4K7KO2" } }), client);
    await handleDriverMedia(d, mediaMsg(s.owner.phone, "m5"), s.owner);
    expect(sent[0].args[0]).toMatch(/PIN-4K7KQ2/);
    expect(sent[0].args[0]).toMatch(/UNPAID/);
  });

  it("6. foreign number → creates load (DRAFT) + lr (driver_upload, needs_review, mapped)", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    const { client, sent } = fakeInterakt();
    const d = depsFor(s, fakeVision({
      ok: true,
      doc: { lrNumber: "B0817", from: "Nagpur", to: "Indore", vehicleNo: "MH04AB1234", docDate: "2026-07-09", billedTotalInr: 12000 },
    }), client);
    await handleDriverMedia(d, mediaMsg(s.owner.phone, "m6"), s.owner);

    expect(sent[0].args[0]).toMatch(/New LR B0817 registered/);
    const newLr = await s.lrs.getByNumber("B0817");
    expect(newLr).toBeTruthy();
    expect(newLr!.source).toBe("driver_upload");
    expect(newLr!.needsReview).toBe(true);
    expect(newLr!.ownerId).toBe(s.owner.id);
    const load = await s.loads.getLoad(newLr!.loadId!);
    expect(load!.status).toBe("DRAFT");
    expect(load!.createdBy).toBe(`driver_upload:${s.owner.id}`);
    expect(load!.fromLocation).toBe("Nagpur");
  });

  it("7. foreign over cap → no new lr created, reply mentions team", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    const config = testConfig();
    for (let i = 0; i < config.lrCreateDailyCap; i++) {
      await s.lrs.create({ lrNumber: `CAP${i}XYZ`, ownerId: s.owner.id, source: "driver_upload" });
    }
    const { client, sent } = fakeInterakt();
    const d = depsFor(s, fakeVision({ ok: true, doc: { lrNumber: "B9999" } }), client, config);
    await handleDriverMedia(d, mediaMsg(s.owner.phone, "m7"), s.owner);

    expect(sent[0].args[0]).toMatch(/team/i);
    expect(await s.lrs.getByNumber("B9999")).toBeNull();
  });

  it("8. unreadable (confidence < 0.5) → ask to type the LR number, doc kind unprocessed", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    const { client, sent } = fakeInterakt();
    const d = depsFor(s, fakeVision({ ok: true, doc: { lrNumber: "PIN-4K7KQ2", confidence: 0.3 } }), client);
    await handleDriverMedia(d, mediaMsg(s.owner.phone, "m8"), s.owner);
    expect(sent[0].args[0]).toMatch(/type the LR number/);
    const doc = await latestDocFor(pool, digits(s.owner.phone));
    expect(doc.kind).toBe("unprocessed");
  });

  it("9. doc_type=other → non-freight reply, doc kind other", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    const { client, sent } = fakeInterakt();
    const d = depsFor(s, fakeVision({ ok: true, doc: { docType: "other" } }), client);
    await handleDriverMedia(d, mediaMsg(s.owner.phone, "m9"), s.owner);
    expect(sent[0].args[0]).toMatch(/doesn't look like an LR or invoice/);
    const doc = await latestDocFor(pool, digits(s.owner.phone));
    expect(doc.kind).toBe("other");
  });

  it("10. vision ok:false (both providers down) → doc unprocessed, reply says team will check", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    const { client, sent } = fakeInterakt();
    const d = depsFor(s, fakeVision({ ok: false, reason: "extract_failed" }), client);
    await handleDriverMedia(d, mediaMsg(s.owner.phone, "m10"), s.owner);
    expect(sent[0].args[0]).toMatch(/team will check/);
    const doc = await latestDocFor(pool, digits(s.owner.phone));
    expect(doc.kind).toBe("unprocessed");
  });

  it("11. paid stamp seen on an UNPAID lr → note contains claims paid, reply still UNPAID", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    const { client, sent } = fakeInterakt();
    const d = depsFor(s, fakeVision({ ok: true, doc: { lrNumber: "PIN-4K7KQ2", paidStampSeen: true } }), client);
    await handleDriverMedia(d, mediaMsg(s.owner.phone, "m11"), s.owner);
    expect(sent[0].args[0]).toMatch(/UNPAID/);
    const updated = await s.lrs.getById(s.lr.id);
    expect(updated!.note).toContain("claims paid");
  });

  it("12. typed fallback: LR-shaped text resolves + replies; non-LR text falls through", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    const { client, sent } = fakeInterakt();
    const d = depsFor(s, fakeVision({ ok: false, reason: "unused" }), client);
    const phone = digits(s.owner.phone);

    const handled = await handleTypedLr(d, "PIN-4K7KQ2", s.owner, phone);
    expect(handled).toBe(true);
    expect(sent[0].args[0]).toMatch(/PIN-4K7KQ2.*UNPAID/);

    const handled2 = await handleTypedLr(d, "HAAN", s.owner, phone);
    expect(handled2).toBe(false);
    expect(sent.length).toBe(1); // no second send — HAAN never reached resolveLr
  });

  it("bonus: media > 8 MB → too-big reply, doc stored unprocessed", async () => {
    const { pool } = await withTestDb();
    const s = await seed(pool);
    const { client, sent } = fakeInterakt();
    const d = depsFor(s, fakeVision({ ok: false, reason: "too_large" }), client);
    await handleDriverMedia(d, mediaMsg(s.owner.phone, "m13"), s.owner);
    expect(sent[0].args[0]).toMatch(/too big/);
    const doc = await latestDocFor(pool, digits(s.owner.phone));
    expect(doc.kind).toBe("unprocessed");
  });
});
