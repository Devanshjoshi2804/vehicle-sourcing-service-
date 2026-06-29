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
});
