CREATE TABLE IF NOT EXISTS owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL UNIQUE,
  vehicle_types text[] NOT NULL DEFAULT '{}',
  lanes jsonb NOT NULL DEFAULT '[]',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_location text NOT NULL,
  to_location text NOT NULL,
  vehicle_type text NOT NULL,
  pickup_date date NOT NULL,
  fixed_price_inr integer NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES loads(id),
  owner_id uuid NOT NULL REFERENCES owners(id),
  phone text NOT NULL,
  flow text NOT NULL DEFAULT 'offer',
  status text NOT NULL DEFAULT 'QUEUED',
  el_conversation_id text,
  attempt_no integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES loads(id),
  owner_id uuid NOT NULL REFERENCES owners(id),
  call_attempt_id uuid REFERENCES call_attempts(id),
  el_conversation_id text,
  available text NOT NULL,
  quoted_price_inr integer,
  accepts_fixed boolean,
  vehicle_type text,
  note text,
  transcript text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS quotes_conversation_uniq
  ON quotes(el_conversation_id) WHERE el_conversation_id IS NOT NULL;
