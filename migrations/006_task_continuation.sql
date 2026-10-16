-- A task started by "continue" points at the failed or cancelled task it picks up from.
ALTER TABLE tasks ADD COLUMN parent_task_id uuid REFERENCES tasks(id);
CREATE INDEX tasks_parent_idx ON tasks (parent_task_id);
