import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { CallsRepo } from "../src/calls/calls.repo.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";

describe("CallsRepo", () => {
  it("creates, updates status, and finds by conversation id", async () => {
    const { pool } = await withTestDb();
    const owner = await new OwnersRepo(pool).createOwner({
      name: "O",
      phone: "+919000000001",
      vehicleTypes: ["16ft"],
      lanes: [],
    });
    const load = await new LoadsRepo(pool).createLoad({
      fromLocation: "A",
      toLocation: "B",
      vehicleType: "16ft",
      pickupDate: "2026-07-01",
      fixedPriceInr: 100,
      createdBy: "d",
    });
    const repo = new CallsRepo(pool);
    const ca = await repo.create({
      loadId: load.id,
      ownerId: owner.id,
      phone: owner.phone,
      flow: "offer",
    });
    expect(ca.status).toBe("QUEUED");
    await repo.setConversationId(ca.id, "conv_1");
    await repo.setStatus(ca.id, "DONE", { ended: true });
    const found = await repo.findByConversationId("conv_1");
    expect(found?.status).toBe("DONE");
    expect(found?.endedAt).toBeTruthy();
  });

  it("supersedePending stops every other live call on the load, keeping the winner", async () => {
    const { pool } = await withTestDb();
    const owners = new OwnersRepo(pool);
    const a = await owners.createOwner({ name: "A", phone: "+919000000010", vehicleTypes: ["16ft"], lanes: [] });
    const b = await owners.createOwner({ name: "B", phone: "+919000000011", vehicleTypes: ["16ft"], lanes: [] });
    const load = await new LoadsRepo(pool).createLoad({
      fromLocation: "A", toLocation: "B", vehicleType: "16ft", pickupDate: "2026-07-01", fixedPriceInr: 100, createdBy: "d",
    });
    const repo = new CallsRepo(pool);
    const ca = await repo.create({ loadId: load.id, ownerId: a.id, phone: a.phone, flow: "offer" });
    const cb = await repo.create({ loadId: load.id, ownerId: b.id, phone: b.phone, flow: "offer" });
    await repo.setStatus(ca.id, "IN_PROGRESS");
    await repo.setStatus(cb.id, "DIALING");

    const n = await repo.supersedePending(load.id, a.id);
    expect(n).toBe(1);
    expect((await repo.getById(ca.id))?.status).toBe("IN_PROGRESS"); // winner untouched
    expect((await repo.getById(cb.id))?.status).toBe("SUPERSEDED");
  });

  it("expireStale closes calls stuck ringing past the timeout", async () => {
    const { pool } = await withTestDb();
    const owner = await new OwnersRepo(pool).createOwner({ name: "O", phone: "+919000000020", vehicleTypes: ["16ft"], lanes: [] });
    const load = await new LoadsRepo(pool).createLoad({
      fromLocation: "A", toLocation: "B", vehicleType: "16ft", pickupDate: "2026-07-01", fixedPriceInr: 100, createdBy: "d",
    });
    const repo = new CallsRepo(pool);
    const ca = await repo.create({ loadId: load.id, ownerId: owner.id, phone: owner.phone, flow: "offer" });
    await repo.setStatus(ca.id, "IN_PROGRESS");
    // backdate it 10 minutes
    await pool.query("UPDATE call_attempts SET created_at = now() - interval '10 minutes' WHERE id=$1", [ca.id]);

    const expired = await repo.expireStale(5 * 60_000);
    expect(expired).toContain(ca.id);
    const after = await repo.getById(ca.id);
    expect(after?.status).toBe("NO_ANSWER");
    expect(after?.endedAt).toBeTruthy();
  });

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
});
