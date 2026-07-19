ALTER TABLE owners ADD COLUMN IF NOT EXISTS email text;
CREATE UNIQUE INDEX IF NOT EXISTS owners_email_unique ON owners(lower(email)) WHERE email IS NOT NULL;
-- channel enums gain 'email'
ALTER TABLE owners DROP CONSTRAINT IF EXISTS owners_channel_check;
ALTER TABLE owners ADD CONSTRAINT owners_channel_check CHECK (channel IN ('voice','whatsapp','both','email'));
ALTER TABLE call_attempts DROP CONSTRAINT IF EXISTS call_attempts_channel_check;
ALTER TABLE call_attempts ADD CONSTRAINT call_attempts_channel_check CHECK (channel IN ('voice','wa','email'));
ALTER TABLE demand_requests DROP CONSTRAINT IF EXISTS demand_requests_channel_check;
ALTER TABLE demand_requests ADD CONSTRAINT demand_requests_channel_check CHECK (channel IN ('voice','whatsapp','console','email'));

CREATE TABLE IF NOT EXISTS email_sessions (
  address       text PRIMARY KEY,                  -- lowercased sender address
  role          text NOT NULL CHECK (role IN ('customer','driver')),
  state         text NOT NULL,
  ctx           jsonb NOT NULL DEFAULT '{}',
  processed_ids text[] NOT NULL DEFAULT '{}',      -- Message-ID dedup, keep last 20
  updated_at    timestamptz NOT NULL DEFAULT now()
);
