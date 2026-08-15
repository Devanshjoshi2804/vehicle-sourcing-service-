-- Campaign outreach: a contact list walks three legs — WhatsApp template (leg 1),
-- DTMF IVR call for the leg-1 refusals (leg 2), human calling for the double
-- refusals (leg 3). One contact row per person per campaign carries the whole
-- journey; `stage` is the single source of truth the funnel is aggregated from.
CREATE TABLE IF NOT EXISTS campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,                 -- 'CMP-0412', shown on every screen
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','RUNNING','CLOSED')),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name           text NOT NULL,
  phone_digits   text NOT NULL,                     -- normalised, digits only
  city           text,
  ref_id         text,                              -- the client's own customer reference
  stage          text NOT NULL DEFAULT 'UPLOADED' CHECK (stage IN (
                   'UPLOADED','INVALID',
                   'L1_SENT','L1_INTERESTED','L1_DECLINED','L1_NO_REPLY',
                   'DOC_RECEIVED','DOC_VERIFIED',
                   'L2_QUEUED','L2_INTERESTED','L2_DECLINED','L2_NO_KEY',
                   'L3_QUEUED','CONFIRMED','CLOSED_LOST')),
  owner_agent    text,                              -- leg 3 human caller
  note           text,                              -- leg 3 disposition note / objection
  invalid_reason text,                              -- why the upload rejected this row
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- "one customer record across WhatsApp, IVR and manual calling" (BRD rule 1):
-- the same number can never enter a campaign twice, by any channel.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_contacts_phone_uniq
  ON campaign_contacts(campaign_id, phone_digits);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_contacts_ref_uniq
  ON campaign_contacts(campaign_id, ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS campaign_contacts_stage ON campaign_contacts(campaign_id, stage);
-- inbound WhatsApp resolves a sender to their live campaign contact by digits
CREATE INDEX IF NOT EXISTS campaign_contacts_digits ON campaign_contacts(phone_digits);

-- Campaign legs get their own attempts table rather than riding call_attempts:
-- that table's load_id/owner_id are NOT NULL FKs into the freight-sourcing domain.
CREATE TABLE IF NOT EXISTS campaign_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL REFERENCES campaign_contacts(id) ON DELETE CASCADE,
  leg          smallint NOT NULL CHECK (leg IN (1,2,3)),
  channel      text NOT NULL CHECK (channel IN ('wa','ivr','manual')),
  status       text NOT NULL DEFAULT 'QUEUED' CHECK (status IN (
                 'QUEUED','DIALING','IN_PROGRESS','DONE','NO_ANSWER','FAILED','SUPERSEDED')),
  provider_ref text,                                -- Interakt message id / Plivo call uuid
  attempt_no   integer NOT NULL DEFAULT 1,
  digit        text,                                -- '1' | '2' for the IVR leg
  duration_s   integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);
CREATE INDEX IF NOT EXISTS campaign_attempts_contact ON campaign_attempts(contact_id, leg);
-- the watchdog and inbound attribution both scan for live attempts
CREATE INDEX IF NOT EXISTS campaign_attempts_live
  ON campaign_attempts(status, created_at) WHERE status IN ('QUEUED','DIALING','IN_PROGRESS');

CREATE TABLE IF NOT EXISTS campaign_docs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES campaign_contacts(id) ON DELETE CASCADE,
  source     text NOT NULL CHECK (source IN ('wa','link')),
  media_url  text,                                  -- BSP-hosted URL (WhatsApp path)
  file_path  text,                                  -- path under UPLOAD_DIR (magic-link path)
  extracted  jsonb NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'received' CHECK (status IN ('received','verified','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_docs_contact ON campaign_docs(contact_id);

-- One audit trail across channels (the BRD's "Customer Timeline" screen).
CREATE TABLE IF NOT EXISTS campaign_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES campaign_contacts(id) ON DELETE CASCADE,
  leg        smallint,
  kind       text NOT NULL,                         -- 'uploaded' | 'wa_sent' | 'wa_reply' | 'ivr_dialed' | ...
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_events_contact ON campaign_events(contact_id, at);

-- A campaign contact is a third kind of WhatsApp sender, alongside driver and customer.
ALTER TABLE wa_sessions DROP CONSTRAINT IF EXISTS wa_sessions_role_check;
ALTER TABLE wa_sessions ADD CONSTRAINT wa_sessions_role_check
  CHECK (role IN ('customer','driver','campaign'));
