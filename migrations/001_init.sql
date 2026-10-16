CREATE TABLE tasks (
  id                  uuid PRIMARY KEY,
  owner               text        NOT NULL,
  goal                text        NOT NULL,
  status              text        NOT NULL
    CHECK (status IN ('queued','planning','running','awaiting_approval','verifying','completed','failed','cancelled')),
  constraints         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  completion_criteria jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tasks_owner_created_idx ON tasks (owner, created_at DESC);
CREATE INDEX tasks_status_idx ON tasks (status);

-- Append-only execution history. seq is per-task and gap-free, assigned under the task row lock.
CREATE TABLE task_events (
  id         bigserial   PRIMARY KEY,
  task_id    uuid        NOT NULL REFERENCES tasks(id),
  seq        integer     NOT NULL,
  type       text        NOT NULL,
  payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, seq)
);

CREATE FUNCTION task_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'task_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER task_events_no_update_delete
  BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW EXECUTE FUNCTION task_events_immutable();
