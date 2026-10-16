-- Transactional outbox: rows are inserted in the same transaction as the event that causes
-- them, so a notification can neither be lost nor describe something that was rolled back.
CREATE TABLE notifications (
  id               uuid PRIMARY KEY,
  task_id          uuid        NOT NULL REFERENCES tasks(id),
  owner            text        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('task_completed','task_failed','approval_requested')),
  ref_id           text,
  dedupe_key       text        NOT NULL UNIQUE,
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_error       text,
  skip_reason      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);

CREATE INDEX notifications_due_idx ON notifications (next_attempt_at) WHERE status IN ('pending','sending');
CREATE INDEX notifications_task_idx ON notifications (task_id);

CREATE TABLE notification_attempts (
  id              bigserial   PRIMARY KEY,
  notification_id uuid        NOT NULL REFERENCES notifications(id),
  at              timestamptz NOT NULL DEFAULT now(),
  ok              boolean     NOT NULL,
  error           text
);
