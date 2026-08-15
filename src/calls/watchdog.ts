import pg from "pg";
import { CallsRepo } from "./calls.repo.js";
import { CampaignAttemptsRepo } from "../campaigns/campaign-attempts.repo.js";

// Background sweep that closes calls stuck ringing/in-progress past the stale
// timeout — without it, a call whose terminal webhook never arrives shows as
// "on air" forever on the board. Returns a stop() to clear the timer.
export function startCallWatchdog(
  pool: pg.Pool,
  opts: {
    staleMinutes: number;
    waStaleMinutes: number;
    emailStaleMinutes: number;
    campaignIvrStaleMinutes?: number;
    intervalMs?: number;
    log?: (msg: string) => void;
  },
): () => void {
  const callsRepo = new CallsRepo(pool);
  const campaignAttempts = new CampaignAttemptsRepo(pool);
  const staleMs = opts.staleMinutes * 60_000;
  const intervalMs = opts.intervalMs ?? 60_000;
  const tick = async () => {
    try {
      const expired = await callsRepo.expireStale(staleMs, "voice");
      const expiredWa = await callsRepo.expireStale(opts.waStaleMinutes * 60_000, "wa");
      const expiredEmail = await callsRepo.expireStale(opts.emailStaleMinutes * 60_000, "email");
      // Campaign IVR calls whose digit/hangup callback never arrived. They stay
      // in the leg-2 queue: the next dial pass retries them (or escalates once
      // the attempt budget is spent).
      const expiredIvr = await campaignAttempts.closeStale(opts.campaignIvrStaleMinutes ?? 10, "ivr");
      const n = expired.length + expiredWa.length + expiredEmail.length + expiredIvr;
      if (n) opts.log?.(`watchdog: closed ${n} stale attempt(s)`);
    } catch (e) {
      opts.log?.(`watchdog error: ${e instanceof Error ? e.message : e}`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // don't keep the process alive just for the watchdog
  void tick(); // run once on boot
  return () => clearInterval(timer);
}
