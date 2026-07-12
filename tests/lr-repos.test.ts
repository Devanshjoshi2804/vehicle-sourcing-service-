import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { LrsRepo } from "../src/lr/lrs.repo.js";
import { DocsRepo } from "../src/lr/docs.repo.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";

async function seed(pool: any) {
  const owner = await new OwnersRepo(pool).createOwner({ name: "R", phone: "+919111100011", vehicleTypes: ["16ft"], lanes: [] });
  const load = await new LoadsRepo(pool).createLoad({ fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-15", fixedPriceInr: 14000, createdBy: "t" });
  return { owner, load };
}

describe("lrs repo", () => {
  it("create/get/markPaid/mapOwner/notes/needsReview", async () => {
    const { pool } = await withTestDb();
    const { owner, load } = await seed(pool);
    const repo = new LrsRepo(pool);
    const lr = await repo.create({ lrNumber: "PIN-4K7KQ2", loadId: load.id, ownerId: owner.id });
    expect(lr).toMatchObject({ status: "UNPAID", source: "system", needsReview: false });
    expect((await repo.getByNumber("PIN-4K7KQ2"))!.id).toBe(lr.id);
    expect((await repo.getByLoad(load.id))!.id).toBe(lr.id);
    const paid = await repo.markPaid(lr.id);
    expect(paid!.status).toBe("PAID");
    expect(paid!.paidAt).toBeTruthy();
    expect(await repo.markPaid(lr.id)).toBeNull(); // already paid — no-op
    await repo.appendNote(lr.id, "claims paid");
    expect((await repo.getById(lr.id))!.note).toContain("claims paid");
    const foreign = await repo.create({ lrNumber: "B0817", ownerId: owner.id, source: "driver_upload", needsReview: true });
    expect((await repo.listNeedsReview()).map((x) => x.id)).toContain(foreign.id);
    expect(await repo.countCreatedToday(owner.id)).toBe(1);
    expect((await repo.listByOwner(owner.id)).length).toBe(2);
    await expect(repo.create({ lrNumber: "PIN-4K7KQ2" })).rejects.toThrow(); // unique
  });
});

describe("docs repo", () => {
  it("upsert dedupes per (owner, lr, kind); dispute lifecycle", async () => {
    const { pool } = await withTestDb();
    const { owner, load } = await seed(pool);
    const lrs = new LrsRepo(pool);
    const docs = new DocsRepo(pool);
    const lr = await lrs.create({ lrNumber: "PIN-AAA111", loadId: load.id, ownerId: owner.id });
    const d1 = await docs.upsert({ ownerId: owner.id, phone: "919111100011", loadId: load.id, lrId: lr.id, kind: "invoice", mediaUrl: "https://m/1.jpg", billedInr: 16500, varianceInr: 2500, dispute: "DISPUTED" });
    const d2 = await docs.upsert({ ownerId: owner.id, phone: "919111100011", loadId: load.id, lrId: lr.id, kind: "invoice", mediaUrl: "https://m/2.jpg", billedInr: 14000, varianceInr: 0, dispute: "NONE" });
    expect(d2.id).toBe(d1.id);                       // updated, not duplicated
    expect(d2.mediaUrl).toBe("https://m/2.jpg");
    expect((await docs.listByLoad(load.id)).length).toBe(1);
    const d3 = await docs.upsert({ phone: "919111100011", kind: "unprocessed", mediaUrl: "https://m/3.jpg" }); // lr-less insert
    expect(d3.id).not.toBe(d1.id);
    const disputed = await docs.upsert({ ownerId: owner.id, phone: "919111100011", lrId: lr.id, kind: "invoice", mediaUrl: "https://m/4.jpg", dispute: "DISPUTED" });
    expect((await docs.resolveDispute(disputed.id))!.dispute).toBe("RESOLVED");
    expect(await docs.resolveDispute(d3.id)).toBeNull(); // not disputed — no-op
  });
});
