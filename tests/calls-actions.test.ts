import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";
import { CallsRepo } from "../src/calls/calls.repo.js";
import { QuotesRepo } from "../src/quotes/quotes.repo.js";
import { DemandRepo } from "../src/demand/demand.repo.js";
import { ActionDeps, acceptAttempt } from "../src/calls/actions.js";

async function setup(pool: any) {
  const owners = new OwnersRepo(pool), loads = new LoadsRepo(pool), calls = new CallsRepo(pool);
  const quotes = new QuotesRepo(pool), demand = new DemandRepo(pool);
  const owner = await owners.createOwner({ name: "R", phone: "+919111111166", vehicleTypes: ["16ft"], lanes: [], channel: "whatsapp" } as any);
  const load = await loads.createLoad({ fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" });
  await loads.setStatus(load.id, "CALLING");
  const attempt = await calls.create({ loadId: load.id, ownerId: owner.id, phone: owner.phone, flow: "offer", channel: "wa" });
  await calls.setConversationId(attempt.id, `wa_${attempt.id}`);
  await calls.setStatus(attempt.id, "IN_PROGRESS");
  const actionDeps: ActionDeps = {
    availability: { quotesRepo: quotes, callsRepo: calls, loadsRepo: loads, demandRepo: demand },
    callsRepo: calls, loadsRepo: loads, demandRepo: demand,
  };
  return { actionDeps, demand, calls, owner, load, attempt, loads };
}

describe("acceptAttempt core", () => {
  it("returns already_yours with the locked price when the demand is already locked to the same owner", async () => {
    const { pool } = await withTestDb();
    const { actionDeps, demand, calls, owner, load, attempt } = await setup(pool);
    // dispatcher pre-locked the load to THIS owner via the console (demand path)
    const { demand: d } = await demand.upsertByConversation({
      customerPhone: "+919888800002", fromText: "Mumbai", toText: "Pune", vehicleType: "16ft",
      offeredPriceInr: 13000, pickupDate: "2026-07-15", elConversationId: "prelock_core_1", channel: "whatsapp",
    } as any);
    await demand.attachLoad(d.id, load.id);
    await demand.setStatus(d.id, "SOURCING");
    await demand.lockDriver(load.id, owner.id, 15000);

    const outcome = await acceptAttempt(actionDeps, attempt.id, 15000);

    expect(outcome).toEqual({ kind: "already_yours", priceInr: 15000 });
    expect((await calls.getById(attempt.id))!.status).toBe("DONE");
  });
});

describe("declineBooking core", () => {
  it("on CUSTOMER_PENDING: returns 'declined' and closes the load", async () => {
    const { pool } = await withTestDb();
    const { actionDeps, demand, loads, owner, load, attempt } = await setup(pool);
    const { demand: d } = await demand.upsertByConversation({
      customerPhone: "+919888800002", fromText: "Mumbai", toText: "Pune", vehicleType: "16ft",
      offeredPriceInr: 13000, pickupDate: "2026-07-15", elConversationId: "decline_core_1", channel: "whatsapp",
    } as any);
    await demand.attachLoad(d.id, load.id);
    await demand.setStatus(d.id, "SOURCING");
    await demand.lockDriver(load.id, owner.id, 15000);
    await demand.approveValue(d.id); // -> CUSTOMER_PENDING

    const { declineBooking } = await import("../src/calls/actions.js");
    const result = await declineBooking(actionDeps, d.id);

    expect(result).toBe("declined");
    expect((await demand.getById(d.id))!.status).toBe("DECLINED");
    expect((await loads.getLoad(load.id))!.status).toBe("CLOSED");
  });

  it("on BOOKED: returns 'not_pending' and leaves both untouched", async () => {
    const { pool } = await withTestDb();
    const { actionDeps, demand, loads, owner, load, attempt } = await setup(pool);
    const { demand: d } = await demand.upsertByConversation({
      customerPhone: "+919888800002", fromText: "Mumbai", toText: "Pune", vehicleType: "16ft",
      offeredPriceInr: 13000, pickupDate: "2026-07-15", elConversationId: "decline_core_2", channel: "whatsapp",
    } as any);
    await demand.attachLoad(d.id, load.id);
    await demand.setStatus(d.id, "SOURCING");
    await demand.lockDriver(load.id, owner.id, 15000);
    await demand.approveValue(d.id);
    await demand.book(d.id); // -> BOOKED
    await loads.setStatus(load.id, "BOOKED"); // also set load to BOOKED

    const { declineBooking } = await import("../src/calls/actions.js");
    const result = await declineBooking(actionDeps, d.id);

    expect(result).toBe("not_pending");
    expect((await demand.getById(d.id))!.status).toBe("BOOKED");
    expect((await loads.getLoad(load.id))!.status).toBe("BOOKED");
  });
});
