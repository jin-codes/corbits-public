-- People who may use this server besides the owner named in .env. `owner` is the same string tasks carry.
CREATE TABLE users (
  owner            text PRIMARY KEY CHECK (owner ~ '^[a-z0-9][a-z0-9_-]{1,31}$'),
  display_name     text        NOT NULL DEFAULT '',
  email            text,
  role             text        NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  token_hash       text        NOT NULL UNIQUE,
  disabled         boolean     NOT NULL DEFAULT false,
  -- null means "use the server default"
  max_concurrent   integer CHECK (max_concurrent IS NULL OR max_concurrent >= 1),
  daily_spend_usd  numeric CHECK (daily_spend_usd IS NULL OR daily_spend_usd >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  token_rotated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz
);
