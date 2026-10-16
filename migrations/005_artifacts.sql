-- Files produced while a task runs (screenshots, captured page text). Bytes live in Postgres for
-- now (small, transactional, covered by the same backups); the ArtifactStore interface hides that.
CREATE TABLE artifacts (
  id          uuid PRIMARY KEY,
  task_id     uuid        NOT NULL REFERENCES tasks(id),
  kind        text        NOT NULL CHECK (kind IN ('screenshot','page_text')),
  mime        text        NOT NULL CHECK (mime IN ('image/jpeg','image/png','text/plain')),
  label       text        NOT NULL,
  -- Which history entry this belongs to, e.g. "tool:<callId>", "approval:<id>", "verification:2".
  attach_key  text        NOT NULL,
  size_bytes  integer     NOT NULL CHECK (size_bytes >= 0),
  sha256      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  data        bytea       NOT NULL
);

CREATE INDEX artifacts_task_idx ON artifacts (task_id, created_at);
CREATE INDEX artifacts_created_idx ON artifacts (created_at);
