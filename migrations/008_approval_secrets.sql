-- A password typed into an approval card, held (encrypted) only until the approved action runs.
-- It is deleted the moment it is used, and purged if it is never used.
CREATE TABLE approval_secrets (
  approval_id uuid PRIMARY KEY REFERENCES approvals(id),
  origin      text        NOT NULL,
  iv          bytea       NOT NULL,
  ciphertext  bytea       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
