-- A person's own Anthropic API key (bring your own key), encrypted like saved logins and write-only.
CREATE TABLE user_api_keys (
  owner        text PRIMARY KEY,
  iv           bytea       NOT NULL,
  ciphertext   bytea       NOT NULL,
  -- last four characters only, so the person can recognize which key is saved
  hint         text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
