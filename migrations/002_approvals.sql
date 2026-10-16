CREATE TABLE approvals (
  id                  uuid PRIMARY KEY,
  task_id             uuid        NOT NULL REFERENCES tasks(id),
  tool                text        NOT NULL,
  input               jsonb       NOT NULL,
  action_fingerprint  text        NOT NULL,
  effect_fingerprint  text        NOT NULL,
  consequential_kind  text,
  status              text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  consumed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  decided_by          text,
  CHECK (consumed_at IS NULL OR status = 'approved')
);

CREATE INDEX approvals_task_idx ON approvals (task_id);
-- One pending request per exact action, so retries of the same proposal do not pile up.
CREATE UNIQUE INDEX approvals_one_pending_per_action
  ON approvals (task_id, action_fingerprint) WHERE status = 'pending';
