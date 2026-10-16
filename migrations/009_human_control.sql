-- A task can be handed to a person who drives the sandboxed browser directly.
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('queued','planning','running','awaiting_approval','human_control','verifying','completed','failed','cancelled'));
