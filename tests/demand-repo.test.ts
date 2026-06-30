import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { DemandRepo } from "../src/demand/demand.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";

const input = {
  customerPhone: "+919888888888",
  fromText: "andheri east",
  toText: "hinjewadi pune",
  fromResolved: { raw: "andheri east", canonical: "Andheri East, Mumbai", city: "Mumbai", state: "Maharashtra", lat: 19.1, lng: 72.8, source: "google" as const },
  toResolved: null,
  vehicleType: "16ft",
  offeredPriceInr: 12000,
  pickupDate: "2026-07-05",
  elConversationId: "conv_demand_1",
  note: "urgent",
};

describe("DemandRepo", () => {
  it("upserts idempotently on conversation id", async () => {
    const { pool } = await withTestDb();
    const repo = new DemandRepo(pool);
    const a = await repo.upsertByConversation(input);
    expect(a.created).toBe(true);
    expect(a.demand.status).toBe("NEW");
    expect(a.demand.fromResolved?.city).toBe("Mumbai");
    expect(a.demand.offeredPriceInr).toBe(12000);
    expect(a.demand.pickupDate).toBe("2026-07-05");

    const b = await repo.upsertByConversation(input);
    expect(b.created).toBe(false);
    expect(b.demand.id).toBe(a.demand.id);
  });

  it("lists by status, sets status, attaches load, finds by load", async () => {
    const { pool } = await withTestDb();
    const repo = new DemandRepo(pool);
    const d = (await repo.upsertByConversation(input)).demand;

    expect(await repo.list({ status: "NEW" })).toHaveLength(1);
    expect(await repo.list({ status: "BOOKED" })).toHaveLength(0);

    const load = await new LoadsRepo(pool).createLoad({
      fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft",
      pickupDate: "2026-07-05", fixedPriceInr: 12000, createdBy: "demand",
    });
    await repo.attachLoad(d.id, load.id);
    await repo.setStatus(d.id, "SOURCING");

    const found = await repo.findByLoadId(load.id);
    expect(found?.id).toBe(d.id);
    expect(found?.status).toBe("SOURCING");
    expect(found?.loadId).toBe(load.id);
  });
});
