import { getPool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";

export function testConnString(): string {
  const cs = process.env.DATABASE_URL_TEST;
  if (!cs) throw new Error("DATABASE_URL_TEST not set — create a local test db");
  return cs;
}

export async function withTestDb() {
  const pool = getPool(testConnString());
  await runMigrations(pool);
  const reset = async () => {
    await pool.query("TRUNCATE quotes, call_attempts, loads, owners, wa_sessions, email_sessions RESTART IDENTITY CASCADE");
  };
  await reset();
  return { pool, reset };
}
