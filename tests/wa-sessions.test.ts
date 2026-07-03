import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { WaSessionsRepo } from "../src/wa/wa-sessions.repo.js";

describe("wa sessions", () => {
  it("upserts, reads, clears", async () => {
    const { pool } = await withTestDb();
    const repo = new WaSessionsRepo(pool);
    expect(await repo.get("911")).toBeNull();
    await repo.upsert({ phone: "911", role: "customer", state: "ASK_PRICE", ctx: { fromText: "Mumbai" } });
    let s = await repo.get("911");
    expect(s).toMatchObject({ role: "customer", state: "ASK_PRICE", ctx: { fromText: "Mumbai" } });
    await repo.upsert({ phone: "911", role: "customer", state: "CONFIRM", lastOptions: [{ id: "ok", title: "Confirm" }] });
    s = await repo.get("911");
    expect(s!.state).toBe("CONFIRM");
    expect(s!.ctx).toMatchObject({ fromText: "Mumbai" }); // ctx merges, not replaced
    expect(s!.lastOptions[0].id).toBe("ok");
    await repo.clear("911");
    const cleared = await repo.get("911");
    // clear keeps the row: IDLE state, ctx reset, lastOptions preserved for
    // resolving taps on older messages, processed_ids preserved for dedup
    expect(cleared).toMatchObject({ state: "IDLE", ctx: {} });
    expect(cleared!.lastOptions[0].id).toBe("ok");
  });

  it("markProcessed dedupes message ids", async () => {
    const { pool } = await withTestDb();
    const repo = new WaSessionsRepo(pool);
    await repo.upsert({ phone: "912", role: "driver", state: "IDLE" });
    expect(await repo.markProcessed("912", "m1")).toBe(true);
    expect(await repo.markProcessed("912", "m1")).toBe(false);
    expect(await repo.markProcessed("912", "m2")).toBe(true);
  });
});
