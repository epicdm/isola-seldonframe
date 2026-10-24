-- v4.41 bounded Uplink public inference pilot.
-- The migration intentionally creates no budget row and enables no spending.
-- (Lane A: the delivered file contained this DDL twice with conflicting definitions; this single block matches
-- src/db/schema/public-turn-spend.ts exactly.)
CREATE TABLE IF NOT EXISTS public_turn_spend_gates (
  id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  model text NOT NULL,
  budget_micro_usd bigint NOT NULL CHECK (budget_micro_usd > 0),
  spent_micro_usd bigint NOT NULL DEFAULT 0 CHECK (spent_micro_usd >= 0),
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  uncertain_micro_usd bigint NOT NULL DEFAULT 0 CHECK (uncertain_micro_usd >= 0),
  enabled boolean NOT NULL DEFAULT false,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > starts_at),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public_turn_spend_reservations (
  id uuid PRIMARY KEY,
  gate_id text NOT NULL REFERENCES public_turn_spend_gates(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id uuid,
  reserved_micro_usd bigint NOT NULL CHECK (reserved_micro_usd > 0),
  actual_micro_usd bigint CHECK (actual_micro_usd >= 0),
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  state text NOT NULL CHECK (state IN ('reserved', 'settled', 'uncertain', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE INDEX IF NOT EXISTS public_turn_spend_reservations_gate_created_idx
  ON public_turn_spend_reservations(gate_id, created_at);
CREATE INDEX IF NOT EXISTS public_turn_spend_reservations_conversation_idx
  ON public_turn_spend_reservations(gate_id, conversation_id, state);
