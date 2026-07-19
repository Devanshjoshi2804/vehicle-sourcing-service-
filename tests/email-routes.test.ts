import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { signAction } from "../src/email/tokens.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";
import { CallsRepo } from "../src/calls/calls.repo.js";
import { DemandRepo } from "../src/demand/demand.repo.js";
import { LrsRepo } from "../src/lr/lrs.repo.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1", GOOGLE_MAPS_API_KEY: "",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };

async function seedLockable(pool: any) {
  const owners = new OwnersRepo(pool), loads = new LoadsRepo(pool);
  const calls = new CallsRepo(pool), demand = new DemandRepo(pool);
  const owner = await owners.createOwner({
    name: "R", phone: "+919111111177", vehicleTypes: ["16ft"], lanes: [],
  } as any);
  const load = await loads.createLoad({
    fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft",
    pickupDate: "2026-07-25", fixedPriceInr: 15000, createdBy: "t",
  });
  await loads.setStatus(load.id, "CALLING");
  const attempt = await calls.create({
    loadId: load.id, ownerId: owner.id, phone: owner.phone, flow: "offer", channel: "email",
  });
  await calls.setConversationId(attempt.id, `wa_${attempt.id}`);
  await calls.setStatus(attempt.id, "IN_PROGRESS");
  const { demand: d } = await demand.upsertByConversation({
    customerPhone: "+919888800009", fromText: "Mumbai", toText: "Pune", vehicleType: "16ft",
    offeredPriceInr: 15000, pickupDate: "2026-07-25", elConversationId: `email_${attempt.id}`,
  });
  await demand.attachLoad(d.id, load.id);
  await demand.setStatus(d.id, "SOURCING");
  return { owners, loads, calls, demand, owner, load, attempt, demandId: d.id };
}

describe("/e/:action magic-link routes", () => {
  it("acc locks the load + demand, re-click is idempotent", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config });
    const { loads, demand, load, attempt, demandId } = await seedLockable(pool);

    const token = signAction(config.webhookSecret, { a: "acc", id: attempt.id, p: 15000 });
    const res = await app.inject({ method: "GET", url: `/e/acc?t=${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("✅ Load accepted");
    expect(res.body).toContain("₹15,000");
    expect((await loads.getLoad(load.id))!.status).toBe("LOCKED");
    expect((await demand.getById(demandId))!.status).toBe("DRIVER_LOCKED");

    // re-click: no state change, "already yours"
    const res2 = await app.inject({ method: "GET", url: `/e/acc?t=${token}` });
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toContain("✅ Already yours");
    expect((await loads.getLoad(load.id))!.status).toBe("LOCKED");
    expect((await demand.getById(demandId))!.status).toBe("DRIVER_LOCKED");
  });

  it("dec marks the attempt not available", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config });
    const { calls, attempt } = await seedLockable(pool);

    const token = signAction(config.webhookSecret, { a: "dec", id: attempt.id });
    const res = await app.inject({ method: "GET", url: `/e/dec?t=${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("👍 Marked not available");
    expect((await calls.getById(attempt.id))!.status).toBe("DONE");
  });

  it("bok books the demand and mints an LR; re-click says already handled", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config });
    const { demand, load, demandId, attempt } = await seedLockable(pool);

    const acc = signAction(config.webhookSecret, { a: "acc", id: attempt.id, p: 15000 });
    await app.inject({ method: "GET", url: `/e/acc?t=${acc}` });
    await demand.approveValue(demandId); // company approval — not part of this task

    const token = signAction(config.webhookSecret, { a: "bok", id: demandId });
    const res = await app.inject({ method: "GET", url: `/e/bok?t=${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("🎉 Trip booked!");
    expect((await demand.getById(demandId))!.status).toBe("BOOKED");

    const lrsRepo = new LrsRepo(pool);
    expect(await lrsRepo.getByLoad(load.id)).toBeTruthy();

    const res2 = await app.inject({ method: "GET", url: `/e/bok?t=${token}` });
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toContain("Already handled");
  });

  it("nbk declines the booking", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config });
    const { demand, loads, load, demandId, attempt } = await seedLockable(pool);
    const acc = signAction(config.webhookSecret, { a: "acc", id: attempt.id, p: 15000 });
    await app.inject({ method: "GET", url: `/e/acc?t=${acc}` });
    await demand.approveValue(demandId);

    const token = signAction(config.webhookSecret, { a: "nbk", id: demandId });
    const res = await app.inject({ method: "GET", url: `/e/nbk?t=${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Booking declined");
    expect((await demand.getById(demandId))!.status).toBe("DECLINED");
    expect((await loads.getLoad(load.id))!.status).toBe("CLOSED");
  });

  it("nbk re-click after /e/bok books says already handled, demand stays BOOKED", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config });
    const { demand, loads, load, demandId, attempt } = await seedLockable(pool);

    // Book the demand via /e/bok
    const acc = signAction(config.webhookSecret, { a: "acc", id: attempt.id, p: 15000 });
    await app.inject({ method: "GET", url: `/e/acc?t=${acc}` });
    await demand.approveValue(demandId);

    const bokToken = signAction(config.webhookSecret, { a: "bok", id: demandId });
    const res = await app.inject({ method: "GET", url: `/e/bok?t=${bokToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("🎉 Trip booked!");
    expect((await demand.getById(demandId))!.status).toBe("BOOKED");
    expect((await loads.getLoad(load.id))!.status).toBe("BOOKED");

    // Try to decline via /e/nbk: should be idempotent, say already handled
    const nbkToken = signAction(config.webhookSecret, { a: "nbk", id: demandId });
    const res2 = await app.inject({ method: "GET", url: `/e/nbk?t=${nbkToken}` });
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toContain("Already handled");
    expect((await demand.getById(demandId))!.status).toBe("BOOKED");
    expect((await loads.getLoad(load.id))!.status).toBe("BOOKED");
  });

  it("rejects a forged token with a 400 expired page", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config });
    const { attempt } = await seedLockable(pool);

    const token = signAction(config.webhookSecret, { a: "acc", id: attempt.id });
    const forged = token.slice(0, -4) + "xxxx";
    const res = await app.inject({ method: "GET", url: `/e/acc?t=${forged}` });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Link expired");
  });

  it("rejects an action-mismatched token (token a=dec used on /e/acc)", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config });
    const { attempt } = await seedLockable(pool);

    const token = signAction(config.webhookSecret, { a: "dec", id: attempt.id });
    const res = await app.inject({ method: "GET", url: `/e/acc?t=${token}` });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Link expired");
  });

  it("rejects an expired token", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config });
    const { attempt } = await seedLockable(pool);

    const token = signAction(config.webhookSecret, {
      a: "acc", id: attempt.id, x: Math.floor(Date.now() / 1000) - 10,
    });
    const res = await app.inject({ method: "GET", url: `/e/acc?t=${token}` });
    expect(res.statusCode).toBe(400);
  });
});
