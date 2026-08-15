import pg from "pg";
import { ContactStage } from "./campaigns.repo.js";
import { toCsv, displayPhone } from "./csv.js";

export type LegReconciliation = {
  leg: "L1" | "L2" | "L3";
  channel: string;
  entered: number;
  key1: number;
  key2: number;
  noAnswer: number;
  toNextLeg: number;
  // entered === key1 + key2 + noAnswer. Rendered as a ✓ in the console; if it is
  // ever false the funnel has a bug, so it is computed, never stored.
  balances: boolean;
};

export type CampaignSummary = {
  totals: { uploaded: number; invalid: number; contacts: number };
  leg1: { sent: number; interested: number; declined: number; noReply: number; docsReceived: number; docsVerified: number };
  leg2: { queued: number; interested: number; declined: number; noKey: number };
  leg3: { queued: number; confirmed: number; closedLost: number };
  closedByAutomation: number;
  manualCalls: number;
  manualReductionPct: number;
  reconciliation: LegReconciliation[];
};

// Everything the dashboard shows is derived from the stage column, so the
// numbers cannot drift from the contacts they describe.
export async function campaignSummary(pool: pg.Pool, campaignId: string): Promise<CampaignSummary> {
  const { rows } = await pool.query(
    `SELECT stage, count(*)::int AS n FROM campaign_contacts WHERE campaign_id=$1 GROUP BY stage`,
    [campaignId],
  );
  const at = (s: ContactStage) => rows.find((r) => r.stage === s)?.n ?? 0;

  // Leg-2 outcomes come from the recorded keypad digits, not from `stage`: a
  // contact that pressed 2 is immediately escalated to L3_QUEUED, so its stage
  // no longer says what it answered on the call.
  const keys = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (a.contact_id) a.contact_id, a.digit, a.status
         FROM campaign_attempts a JOIN campaign_contacts c ON c.id=a.contact_id
        WHERE c.campaign_id=$1 AND a.leg=2
        ORDER BY a.contact_id, a.created_at DESC
     )
     SELECT count(*) FILTER (WHERE digit='1')::int AS key1,
            count(*) FILTER (WHERE digit='2')::int AS key2,
            count(*) FILTER (WHERE digit IS NULL)::int AS no_key,
            count(*)::int AS dialed
       FROM latest`,
    [campaignId],
  );

  const docs = await pool.query(
    `SELECT count(*)::int AS received, count(*) FILTER (WHERE d.status='verified')::int AS verified
       FROM campaign_docs d JOIN campaign_contacts c ON c.id=d.contact_id WHERE c.campaign_id=$1`,
    [campaignId],
  );

  const invalid = at("INVALID");
  const total = rows.reduce((s, r) => s + r.n, 0);

  // A contact that has moved past a leg still counts as having entered it.
  const docStages = at("DOC_RECEIVED") + at("DOC_VERIFIED");
  const l1Interested = at("L1_INTERESTED") + docStages;
  const l3Total = at("L3_QUEUED") + at("CONFIRMED") + at("CLOSED_LOST");
  const k = keys.rows[0];
  const l2Interested = k.key1;
  const l2Declined = k.key2;
  const l2NoKey = k.no_key;
  // Everyone dialed, plus anyone enrolled but not yet dialed.
  const l2Entered = k.dialed + at("L2_QUEUED");
  // Leg 1's refusals = those already enrolled in leg 2 PLUS those that answered
  // "2" but have not been dialed yet (they sit at L1_DECLINED until enrolment).
  const l1Declined = at("L1_DECLINED") + l2Entered;
  const l1NoReply = at("L1_NO_REPLY");
  const l1Sent = at("L1_SENT") + l1Interested + l1Declined + l1NoReply;

  const closedByAutomation = l1Interested + l2Interested;
  const manualCalls = l3Total;
  const contacts = total - invalid;

  const reconciliation: LegReconciliation[] = [
    row("L1", "WhatsApp", l1Sent, l1Interested, l1Declined, l1NoReply, l1Declined),
    row("L2", "IVR call", l2Entered, l2Interested, l2Declined, l2NoKey + at("L2_QUEUED"), l3Total),
    // L3 has no keypad: "key1/key2" are the caller's dispositions.
    row("L3", "Manual", l3Total, at("CONFIRMED"), at("CLOSED_LOST"), at("L3_QUEUED"), 0),
  ];

  return {
    // "uploaded" is every row the sheet produced, whatever stage it reached now.
    totals: { uploaded: total, invalid, contacts },
    leg1: {
      sent: l1Sent,
      interested: l1Interested,
      declined: l1Declined,
      noReply: l1NoReply,
      docsReceived: docs.rows[0].received,
      docsVerified: docs.rows[0].verified,
    },
    leg2: { queued: l2Entered, interested: l2Interested, declined: l2Declined, noKey: l2NoKey },
    leg3: { queued: at("L3_QUEUED"), confirmed: at("CONFIRMED"), closedLost: at("CLOSED_LOST") },
    closedByAutomation,
    manualCalls,
    manualReductionPct: contacts ? Math.round(((contacts - manualCalls) / contacts) * 100) : 0,
    reconciliation,
  };
}

function row(
  leg: LegReconciliation["leg"],
  channel: string,
  entered: number,
  key1: number,
  key2: number,
  noAnswer: number,
  toNextLeg: number,
): LegReconciliation {
  return { leg, channel, entered, key1, key2, noAnswer, toNextLeg, balances: entered === key1 + key2 + noAnswer };
}

export type ExportLeg = "1" | "2" | "3" | "all";

// Per-leg CSV downloads. One query per leg rather than one giant join, because
// each leg's columns are what the operator actually wants in the sheet.
export async function exportCsv(pool: pg.Pool, campaignId: string, leg: ExportLeg): Promise<string> {
  if (leg === "1") {
    const { rows } = await pool.query(
      `SELECT c.name, c.phone_digits, c.city, c.stage,
              (SELECT a.created_at FROM campaign_attempts a
                WHERE a.contact_id=c.id AND a.leg=1 ORDER BY a.created_at LIMIT 1) AS sent_at,
              (SELECT count(*) FROM campaign_docs d WHERE d.contact_id=c.id)::int AS docs
         FROM campaign_contacts c WHERE c.campaign_id=$1 ORDER BY c.created_at`,
      [campaignId],
    );
    return toCsv(
      ["name", "phone", "city", "stage", "sent_at", "documents"],
      rows.map((r) => [r.name, displayPhone(r.phone_digits), r.city, r.stage, iso(r.sent_at), r.docs]),
    );
  }

  if (leg === "2") {
    const { rows } = await pool.query(
      `SELECT c.name, c.phone_digits, a.attempt_no, a.status, a.digit, a.duration_s, a.created_at
         FROM campaign_attempts a JOIN campaign_contacts c ON c.id=a.contact_id
        WHERE c.campaign_id=$1 AND a.leg=2 ORDER BY a.created_at`,
      [campaignId],
    );
    return toCsv(
      ["name", "phone", "attempt", "status", "key", "duration_s", "dialed_at"],
      rows.map((r) => [r.name, displayPhone(r.phone_digits), r.attempt_no, r.status, r.digit, r.duration_s, iso(r.created_at)]),
    );
  }

  if (leg === "3") {
    const { rows } = await pool.query(
      `SELECT c.name, c.phone_digits, c.stage, c.owner_agent, c.note, c.updated_at,
              (SELECT count(*) FROM campaign_attempts a WHERE a.contact_id=c.id)::int AS attempts
         FROM campaign_contacts c
        WHERE c.campaign_id=$1 AND c.stage IN ('L3_QUEUED','CONFIRMED','CLOSED_LOST')
        ORDER BY c.updated_at`,
      [campaignId],
    );
    return toCsv(
      ["name", "phone", "status", "owner", "note", "attempts", "updated_at"],
      rows.map((r) => [r.name, displayPhone(r.phone_digits), r.stage, r.owner_agent, r.note, r.attempts, iso(r.updated_at)]),
    );
  }

  // "all" — one row per person with every leg's outcome, the BRD's
  // "every person, every leg" view.
  const { rows } = await pool.query(
    `SELECT c.name, c.phone_digits, c.city, c.ref_id, c.stage, c.owner_agent, c.note, c.invalid_reason,
            (SELECT a.status FROM campaign_attempts a
              WHERE a.contact_id=c.id AND a.leg=1 ORDER BY a.created_at DESC LIMIT 1) AS leg1,
            (SELECT a.digit FROM campaign_attempts a
              WHERE a.contact_id=c.id AND a.leg=2 AND a.digit IS NOT NULL
              ORDER BY a.created_at DESC LIMIT 1) AS leg2_key,
            (SELECT count(*) FROM campaign_attempts a WHERE a.contact_id=c.id)::int AS attempts,
            (SELECT count(*) FROM campaign_docs d WHERE d.contact_id=c.id)::int AS docs
       FROM campaign_contacts c WHERE c.campaign_id=$1 ORDER BY c.created_at`,
    [campaignId],
  );
  return toCsv(
    ["name", "phone", "city", "ref", "stage", "leg1", "leg2_key", "attempts", "documents", "owner", "note", "invalid_reason"],
    rows.map((r) => [
      r.name, displayPhone(r.phone_digits), r.city, r.ref_id, r.stage, r.leg1, r.leg2_key,
      r.attempts, r.docs, r.owner_agent, r.note, r.invalid_reason,
    ]),
  );
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
