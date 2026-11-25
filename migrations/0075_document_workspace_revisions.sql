-- Cheap cache revalidation, including deletions and folder moves.
BEGIN;
CREATE TABLE document_workspace_revisions (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1
);
ALTER TABLE document_workspace_revisions ENABLE ROW LEVEL SECURITY;
INSERT INTO document_workspace_revisions (user_id) SELECT id FROM users;

CREATE FUNCTION bump_document_workspace_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
BEGIN
  owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  INSERT INTO document_workspace_revisions (user_id, revision)
    SELECT owner_id, 1 WHERE EXISTS (SELECT 1 FROM users WHERE id = owner_id)
    ON CONFLICT (user_id) DO UPDATE SET revision = document_workspace_revisions.revision + 1;
  RETURN NULL;
END;
$$;

CREATE TRIGGER documents_workspace_revision
  AFTER INSERT OR DELETE OR UPDATE OF title, folder_id, emoji, starred, tags, blocks ON documents
  FOR EACH ROW EXECUTE FUNCTION bump_document_workspace_revision();
CREATE TRIGGER folders_workspace_revision
  AFTER INSERT OR DELETE OR UPDATE OF title, parent_id, emoji ON document_folders
  FOR EACH ROW EXECUTE FUNCTION bump_document_workspace_revision();
COMMIT;
