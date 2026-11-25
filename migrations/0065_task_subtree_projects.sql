-- A child belongs to the same project as its root. Older PATCH handlers
-- moved only the root, leaving children hidden in the previous project.
-- Repair existing trees without dropping tasks or changing their parents.
BEGIN;
LOCK TABLE public.task_items IN SHARE ROW EXCLUSIVE MODE;

WITH RECURSIVE tree AS (
  SELECT id, user_id, project_id FROM public.task_items WHERE parent_id IS NULL
  UNION
  SELECT child.id, child.user_id, tree.project_id
  FROM public.task_items child JOIN tree ON child.parent_id = tree.id
  WHERE child.user_id = tree.user_id
)
UPDATE public.task_items item
SET project_id = tree.project_id, updated_at = now(), search_indexed_at = NULL
FROM tree
WHERE item.id = tree.id AND item.project_id IS DISTINCT FROM tree.project_id;

-- Supports descendant moves, child aggregation, and parent deletion checks.
CREATE INDEX IF NOT EXISTS task_items_parent_idx ON public.task_items (parent_id)
WHERE parent_id IS NOT NULL;
COMMIT;
