import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fakeInterakt } from "./helpers/wa.js";
import { LrsRepo } from "../src/lr/lrs.repo.js";
import { DocsRepo } from "../src/lr/docs.repo.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1", INTERAKT_API_KEY: "ik",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };

async function seed(pool: any, channel: "voice" | "whatsapp" = "voice") {
  const owner = await new OwnersRepo(pool).createOwner({
    name: "R", phone: "+919111100033", vehicleTypes: ["16ft"], lanes: [], channel,
  });
  const load = await new LoadsRepo(pool).createLoad({
    fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-15", fixedPriceInr: 14000, createdBy: "t",
  });
  return { owner, load };
}

describe("lr console routes", () => {
  it("GET /loads/:id/docs returns the mapped lr (or null) plus docs", async () => {
    const { pool } = await withTestDb();
    const { owner, load } = await seed(pool);
    const lrsRepo = new LrsRepo(pool);
    const docsRepo = new DocsRepo(pool);
    const lr = await lrsRepo.create({ lrNumber: "PIN-4K7KQ2", loadId: load.id, ownerId: owner.id });
    const doc = await docsRepo.upsert({ ownerId: owner.id, phone: owner.phone, loadId: load.id, lrId: lr.id, kind: "lr", mediaUrl: "https://x/1.jpg" });

    const app = buildServer({ pool, config });
    const res = await app.inject({ method: "GET", url: `/loads/${load.id}/docs`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lr.id).toBe(lr.id);
    expect(body.docs.map((d: any) => d.id)).toContain(doc.id);
  });

  it("GET /loads/:id/docs returns lr: null when no LR is mapped", async () => {
    const { pool } = await withTestDb();
    const { load } = await seed(pool);
    const app = buildServer({ pool, config });
    const res = await app.inject({ method: "GET", url: `/loads/${load.id}/docs`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lr: null, docs: [] });
  });

  it("GET /lrs?needsReview=true lists lrs flagged for review", async () => {
    const { pool } = await withTestDb();
    const { owner } = await seed(pool);
    const lrsRepo = new LrsRepo(pool);
    const flagged = await lrsRepo.create({ lrNumber: "B0817", ownerId: owner.id, source: "driver_upload", needsReview: true });
    const app = buildServer({ pool, config });
    const res = await app.inject({ method: "GET", url: "/lrs?needsReview=true", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((x: any) => x.id)).toContain(flagged.id);
  });

  it("POST /lrs/:id/mark-paid marks paid and best-effort WA-notifies a whatsapp-channel owner", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const { owner, load } = await seed(pool, "whatsapp");
    const lrsRepo = new LrsRepo(pool);
    const lr = await lrsRepo.create({ lrNumber: "PIN-4K7KQ2", loadId: load.id, ownerId: owner.id });

    const app = buildServer({ pool, config, interakt: client });
    const res = await app.inject({ method: "POST", url: `/lrs/${lr.id}/mark-paid`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("PAID");
    expect(body.paidAt).toBeTruthy();

    const notify = sent.find((s) => s.kind === "text" && /Payment released/.test(s.args[0]));
    expect(notify).toBeTruthy();
    expect(notify!.args[0]).toContain("PIN-4K7KQ2");
    expect(notify!.args[0]).toContain("14,000");
  });

  it("POST /lrs/:id/mark-paid skips the WA notify for a voice-channel owner and is a no-op the second time (409)", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const { owner, load } = await seed(pool, "voice");
    const lrsRepo = new LrsRepo(pool);
    const lr = await lrsRepo.create({ lrNumber: "PIN-VOICE1", loadId: load.id, ownerId: owner.id });

    const app = buildServer({ pool, config, interakt: client });
    const res1 = await app.inject({ method: "POST", url: `/lrs/${lr.id}/mark-paid`, headers: auth });
    expect(res1.statusCode).toBe(200);
    expect(sent.some((s) => s.kind === "text" && /Payment released/.test(s.args[0]))).toBe(false);

    const res2 = await app.inject({ method: "POST", url: `/lrs/${lr.id}/mark-paid`, headers: auth });
    expect(res2.statusCode).toBe(409);
  });

  it("POST /lrs/:id/mark-paid on an LR with no load/owner still succeeds (skips notify gracefully)", async () => {
    const { pool } = await withTestDb();
    const lrsRepo = new LrsRepo(pool);
    const lr = await lrsRepo.create({ lrNumber: "PIN-ORPHN1" });
    const app = buildServer({ pool, config });
    const res = await app.inject({ method: "POST", url: `/lrs/${lr.id}/mark-paid`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("PAID");
  });

  it("POST /lrs/:id/mark-paid 404s on an unknown id", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config });
    const res = await app.inject({ method: "POST", url: "/lrs/00000000-0000-0000-0000-000000000000/mark-paid", headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it("POST /docs/:id/resolve-dispute resolves a DISPUTED doc, 409s on a second call, 404s unknown", async () => {
    const { pool } = await withTestDb();
    const { owner, load } = await seed(pool);
    const docsRepo = new DocsRepo(pool);
    const doc = await docsRepo.upsert({
      ownerId: owner.id, phone: owner.phone, loadId: load.id, kind: "invoice",
      mediaUrl: "https://x/2.jpg", dispute: "DISPUTED",
    });

    const app = buildServer({ pool, config });
    const res = await app.inject({ method: "POST", url: `/docs/${doc.id}/resolve-dispute`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dispute: "RESOLVED" });

    const res2 = await app.inject({ method: "POST", url: `/docs/${doc.id}/resolve-dispute`, headers: auth });
    expect(res2.statusCode).toBe(409);

    const res3 = await app.inject({ method: "POST", url: "/docs/00000000-0000-0000-0000-000000000000/resolve-dispute", headers: auth });
    expect(res3.statusCode).toBe(404);
  });

  it("POST /docs/:id/resolve-dispute 409s on a doc that was never disputed", async () => {
    const { pool } = await withTestDb();
    const { owner, load } = await seed(pool);
    const docsRepo = new DocsRepo(pool);
    const doc = await docsRepo.upsert({ ownerId: owner.id, phone: owner.phone, loadId: load.id, kind: "lr", mediaUrl: "https://x/3.jpg" });
    const app = buildServer({ pool, config });
    const res = await app.inject({ method: "POST", url: `/docs/${doc.id}/resolve-dispute`, headers: auth });
    expect(res.statusCode).toBe(409);
  });
});
