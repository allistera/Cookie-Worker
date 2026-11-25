-- Ordered follow-up pagination and bounded latest-message lookups.
BEGIN;

CREATE INDEX messages_follow_up_page_idx
  ON messages (user_id, follow_up_at DESC, id DESC)
  WHERE is_sent AND NOT is_deleted AND NOT is_archived AND follow_up_at IS NOT NULL;

CREATE INDEX messages_thread_latest_idx
  ON messages (user_id, thread_id, sent_at DESC, id DESC)
  WHERE NOT is_deleted;

CREATE INDEX documents_workspace_page_idx
  ON documents (user_id, updated_at DESC, id DESC);

CREATE INDEX documents_folder_page_idx
  ON documents (user_id, folder_id, updated_at DESC, id DESC);

CREATE INDEX task_items_project_page_idx
  ON task_items (user_id, project_id, position, created_at, id)
  WHERE parent_id IS NULL AND completed_at IS NULL;
CREATE INDEX task_items_today_page_idx
  ON task_items (user_id, due_date, (COALESCE(today_position, 'Infinity'::float8)), position, created_at, id)
  WHERE parent_id IS NULL AND completed_at IS NULL;
CREATE INDEX task_items_children_page_idx
  ON task_items (user_id, parent_id, position, created_at, id)
  WHERE parent_id IS NOT NULL;

COMMIT;
