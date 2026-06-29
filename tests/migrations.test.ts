import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";

describe("migrations", () => {
  it("creates all four tables", async () => {
    const { pool } = await withTestDb();
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name = ANY($1)`,
      [["owners", "loads", "call_attempts", "quotes"]],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual(
      ["call_attempts", "loads", "owners", "quotes"],
    );
  });
});
