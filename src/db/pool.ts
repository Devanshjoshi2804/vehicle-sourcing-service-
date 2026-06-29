import pg from "pg";

// Return SQL DATE (oid 1082) as a raw 'YYYY-MM-DD' string instead of a JS Date.
// pg parses DATE into a local-midnight Date; calling toISOString() later would
// shift it across the UTC boundary (e.g. IST +5:30 → previous day). Keeping the
// string avoids that off-by-one entirely.
pg.types.setTypeParser(1082, (v) => v);

const pools = new Map<string, pg.Pool>();

export function getPool(connectionString: string): pg.Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new pg.Pool({ connectionString });
    pools.set(connectionString, pool);
  }
  return pool;
}
