-- LR (lorry receipt) & driver document tracking: LR minting on load BOOKED,
-- document upload/OCR extraction (vision-classified), and invoice matching.
CREATE TABLE IF NOT EXISTS lrs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lr_number     text NOT NULL UNIQUE,             -- 'PIN-4K7KQ2' (system) or foreign number
  load_id       uuid REFERENCES loads(id),
  owner_id      uuid REFERENCES owners(id),        -- the driver it's mapped to
  status        text NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID','PAID')),
  paid_at       timestamptz,
  source        text NOT NULL DEFAULT 'system' CHECK (source IN ('system','driver_upload')),
  needs_review  boolean NOT NULL DEFAULT false,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS driver_docs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid REFERENCES owners(id),
  phone         text NOT NULL,                     -- digits, sender
  load_id       uuid REFERENCES loads(id),
  lr_id         uuid REFERENCES lrs(id),
  kind          text NOT NULL CHECK (kind IN ('lr','invoice','other','unprocessed')),
  media_url     text NOT NULL,
  extracted     jsonb NOT NULL DEFAULT '{}',
  billed_inr    integer,
  variance_inr  integer,                           -- billed - agreed (invoices only)
  dispute       text NOT NULL DEFAULT 'NONE' CHECK (dispute IN ('NONE','DISPUTED','RESOLVED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- re-upload updates the same row rather than piling up duplicates
CREATE UNIQUE INDEX IF NOT EXISTS driver_docs_owner_lr_kind ON driver_docs(owner_id, lr_id, kind) WHERE lr_id IS NOT NULL;
