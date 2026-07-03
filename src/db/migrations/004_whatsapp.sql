-- WhatsApp channel: per-owner preference, channel-tagged attempts/demands, and
-- chat session state for the intake/offer conversations.
ALTER TABLE owners ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'voice'
  CHECK (channel IN ('voice','whatsapp','both'));
ALTER TABLE call_attempts ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'voice'
  CHECK (channel IN ('voice','wa'));
ALTER TABLE demand_requests ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'voice'
  CHECK (channel IN ('voice','whatsapp','console'));

CREATE TABLE IF NOT EXISTS wa_sessions (
  phone         text PRIMARY KEY,          -- digits only, e.g. '919888888888'
  role          text NOT NULL CHECK (role IN ('customer','driver')),
  state         text NOT NULL,
  ctx           jsonb NOT NULL DEFAULT '{}',
  last_options  jsonb NOT NULL DEFAULT '[]',
  processed_ids text[] NOT NULL DEFAULT '{}',
  updated_at    timestamptz NOT NULL DEFAULT now()
);
