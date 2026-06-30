-- The "domino" sourcing flow: a customer demand auto-calls drivers, the first
-- driver to accept the fixed price locks the load, then the company approves the
-- value, then the customer is confirmed. These columns track the lock + the two
-- approval gates. Statuses live in text columns (no enum), so the new demand /
-- load / call_attempt states need no DDL beyond these.
ALTER TABLE demand_requests
  ADD COLUMN IF NOT EXISTS winning_owner_id uuid REFERENCES owners(id),
  ADD COLUMN IF NOT EXISTS locked_price_inr integer,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS booked_at timestamptz;

-- The stale-call watchdog scans for calls stuck ringing/in-progress past a
-- timeout; this index keeps that scan cheap.
CREATE INDEX IF NOT EXISTS call_attempts_live_idx
  ON call_attempts(status, created_at)
  WHERE status IN ('DIALING', 'IN_PROGRESS');

-- Migrate legacy demand statuses from the old (approve-first) flow to the domino:
-- CONFIRMED (owner accepted + customer auto-confirmed) ≈ BOOKED; APPROVED ≈ SOURCING.
UPDATE demand_requests SET status='BOOKED'   WHERE status='CONFIRMED';
UPDATE demand_requests SET status='SOURCING' WHERE status='APPROVED';
