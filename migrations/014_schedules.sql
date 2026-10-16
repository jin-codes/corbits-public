-- Tasks that start themselves on a schedule. Each run is an ordinary task (history, approvals, limits and all);
-- the schedule only decides when to create it.
CREATE TABLE schedules (
  id                  uuid PRIMARY KEY,
  owner               text        NOT NULL,
  name                text        NOT NULL,
  goal                text        NOT NULL,
  completion_criteria jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- the limits the owner asked for; they are resolved against the server's maximums at every run
  limits              jsonb,
  logins              text[]      NOT NULL DEFAULT '{}',
  spec                jsonb       NOT NULL,
  timezone            text        NOT NULL,
  enabled             boolean     NOT NULL DEFAULT true,
  -- null while paused
  next_run_at         timestamptz,
  -- an interval keeps its rhythm relative to this
  anchor_at           timestamptz NOT NULL DEFAULT now(),
  paused_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedules_due_idx ON schedules (next_run_at) WHERE enabled;
CREATE INDEX schedules_owner_idx ON schedules (owner);

-- What happened each time a schedule came due, including the times nothing was started and why.
CREATE TABLE schedule_runs (
  id          bigserial   PRIMARY KEY,
  schedule_id uuid        NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  due_at      timestamptz NOT NULL,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  outcome     text        NOT NULL CHECK (outcome IN ('started','skipped_overlap','skipped_late','skipped_quota','skipped_blocked','paused','error')),
  task_id     uuid,
  detail      text
);
CREATE INDEX schedule_runs_schedule_idx ON schedule_runs (schedule_id, id DESC);
