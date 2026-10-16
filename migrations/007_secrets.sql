-- Saved credentials. Values are encrypted with AES-256-GCM before they reach this table; the
-- key lives only in the server's environment. name + origin are not secret and are shown to the AI.
CREATE TABLE secrets (
  id           uuid PRIMARY KEY,
  owner        text        NOT NULL,
  name         text        NOT NULL,
  origin       text        NOT NULL,
  iv           bytea       NOT NULL,
  ciphertext   bytea       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (owner, name)
);
