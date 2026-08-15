import pg from "pg";
import { Contact, rowToContact } from "./campaigns.repo.js";
import { CampaignEvent } from "./campaign-docs.repo.js";

export type QueueRow = Contact & {
  // Both automated refusals sit on the record before anyone dials, so the caller
  // opens with context (the BRD's leg-3 requirement).
  leg1Result: string | null;
  leg2Result: string | null;
  attempts: number;
  lastTouch: string | null;
  history: CampaignEvent[];
};

// One query for the whole queue: the contact, its per-leg outcome, how many
// times it has been tried, and the timeline — no N+1 per row.
export async function listManualQueue(pool: pg.Pool, campaignId: string): Promise<QueueRow[]> {
  const { rows } = await pool.query(
    `SELECT c.*,
            (SELECT a.status FROM campaign_attempts a
              WHERE a.contact_id=c.id AND a.leg=1 ORDER BY a.created_at DESC LIMIT 1) AS leg1_status,
            (SELECT a.digit FROM campaign_attempts a
              WHERE a.contact_id=c.id AND a.leg=2 AND a.digit IS NOT NULL
              ORDER BY a.created_at DESC LIMIT 1) AS leg2_digit,
            (SELECT count(*) FROM campaign_attempts a WHERE a.contact_id=c.id)::int AS attempts,
            (SELECT max(a.created_at) FROM campaign_attempts a WHERE a.contact_id=c.id) AS last_touch,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id', e.id, 'contactId', e.contact_id, 'leg', e.leg,
                       'kind', e.kind, 'detail', e.detail, 'at', e.at) ORDER BY e.at)
                FROM campaign_events e WHERE e.contact_id=c.id
            ), '[]'::json) AS history
       FROM campaign_contacts c
      WHERE c.campaign_id=$1
        AND c.stage IN ('L3_QUEUED','CONFIRMED','CLOSED_LOST')
      ORDER BY c.updated_at`,
    [campaignId],
  );

  return rows.map((r) => ({
    ...rowToContact(r),
    // Leg 1 is always a "2" for anyone who reached leg 3 — the queue is defined
    // as the double refusals — but read it rather than assuming.
    leg1Result: r.leg1_status === "DONE" ? "2 · declined" : r.leg1_status ? String(r.leg1_status).toLowerCase() : null,
    leg2Result: r.leg2_digit ? `${r.leg2_digit} · ${r.leg2_digit === "2" ? "declined" : "interested"}` : "no key",
    attempts: r.attempts,
    lastTouch: r.last_touch ? r.last_touch.toISOString() : null,
    history: r.history as CampaignEvent[],
  }));
}
