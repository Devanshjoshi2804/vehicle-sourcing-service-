CREATE TABLE IF NOT EXISTS demand_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_phone text NOT NULL,
  from_text text NOT NULL,
  to_text text NOT NULL,
  from_resolved jsonb,
  to_resolved jsonb,
  vehicle_type text,
  offered_price_inr integer,
  pickup_date date,
  status text NOT NULL DEFAULT 'NEW',
  load_id uuid REFERENCES loads(id),
  el_conversation_id text,
  transcript text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS demand_conversation_uniq
  ON demand_requests(el_conversation_id) WHERE el_conversation_id IS NOT NULL;
