import pg from "pg";
import { CallsRepo } from "./calls.repo.js";

// Background sweep that closes calls stuck ringing/in-progress past the stale
// timeout — without it, a call whose terminal webhook never arrives shows as
// "on air" forever on the board. Returns a stop() to clear the timer.
export function startCallWatchdog(
  pool: pg.Pool,
  opts: { staleMinutes: number; intervalMs?: number; log?: (msg: string) => void },
): () => void {
  const callsRepo = new CallsRepo(pool);
  const staleMs = opts.staleMinutes * 60_000;
  const intervalMs = opts.intervalMs ?? 60_000;
  const tick = async () => {
    try {
      const expired = await callsRepo.expireStale(staleMs);
      if (expired.length) opts.log?.(`watchdog: closed ${expired.length} stale call(s)`);
    } catch (e) {
      opts.log?.(`watchdog error: ${e instanceof Error ? e.message : e}`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // don't keep the process alive just for the watchdog
  void tick(); // run once on boot
  return () => clearInterval(timer);
}
