-- The agent can ask its owner for help (CAPTCHA, verification code); that is a new kind of notification.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_completed','task_failed','approval_requested','help_requested'));
