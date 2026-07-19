import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { EmailSessionsRepo } from "../src/email/email-sessions.repo.js";

describe("email sessions", () => {
  it("upserts, reads, clears", async () => {
    const { pool } = await withTestDb();
    const repo = new EmailSessionsRepo(pool);
    expect(await repo.get("a@b.com")).toBeNull();
    await repo.upsert({ address: "a@b.com", role: "customer", state: "ASK_PRICE", ctx: { fromText: "Mumbai" } });
    let s = await repo.get("a@b.com");
    expect(s).toMatchObject({ role: "customer", state: "ASK_PRICE", ctx: { fromText: "Mumbai" } });
    await repo.upsert({ address: "a@b.com", role: "customer", state: "CONFIRM", ctx: { lastInbound: "m1" } });
    s = await repo.get("a@b.com");
    expect(s!.state).toBe("CONFIRM");
    expect(s!.ctx).toMatchObject({ fromText: "Mumbai", lastInbound: "m1" }); // ctx merges, not replaced
    await repo.clear("a@b.com");
    const cleared = await repo.get("a@b.com");
    // clear keeps the row: IDLE state, ctx reset except lastInbound, processed_ids preserved
    expect(cleared).toMatchObject({ state: "IDLE", ctx: { lastInbound: "m1" } });
  });

  it("markProcessed dedupes message ids, survives clear", async () => {
    const { pool } = await withTestDb();
    const repo = new EmailSessionsRepo(pool);
    await repo.upsert({ address: "d@e.com", role: "driver", state: "IDLE" });
    expect(await repo.markProcessed("d@e.com", "m1")).toBe(true);
    expect(await repo.markProcessed("d@e.com", "m1")).toBe(false);
    expect(await repo.markProcessed("d@e.com", "m2")).toBe(true);
    await repo.clear("d@e.com");
    // processed_ids dedup still works after clear
    expect(await repo.markProcessed("d@e.com", "m2")).toBe(false);
  });
});
