-- A task with no completion criteria can still run, but its result cannot be checked. It ends in
-- 'unverified' (never 'completed', which always means verified), and that end is a new kind of notification.
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('queued','planning','running','awaiting_approval','human_control','verifying','completed','unverified','failed','cancelled'));
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_completed','task_failed','task_unverified','approval_requested','help_requested'));
