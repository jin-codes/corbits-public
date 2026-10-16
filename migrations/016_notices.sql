-- A notice is a plain message to one owner that is not about a task (for example "a job on another
-- system needs a look"). It rides the same outbox, so it gets the same retries, Message-ID and
-- redaction. Its subject and body are written by an authenticated caller (POST /notify), and it is
-- only ever mailed to that caller's own address.
ALTER TABLE notifications ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN subject text;
ALTER TABLE notifications ADD COLUMN body text;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_completed','task_failed','task_unverified','approval_requested','help_requested','notice'));
ALTER TABLE notifications ADD CONSTRAINT notifications_notice_shape
  CHECK ((kind = 'notice' AND task_id IS NULL AND subject IS NOT NULL AND body IS NOT NULL)
      OR (kind <> 'notice' AND task_id IS NOT NULL));
