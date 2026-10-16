-- A saved browser login (cookies and local storage for ONE site), so a task can start already signed in.
-- Encrypted like saved passwords: write-only, bound to its owner, name and site.
CREATE TABLE login_states (
  id           uuid PRIMARY KEY,
  owner        text        NOT NULL,
  name         text        NOT NULL,
  origin       text        NOT NULL,
  iv           bytea       NOT NULL,
  ciphertext   bytea       NOT NULL,
  cookie_count integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (owner, name)
);
