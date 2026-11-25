-- 0002_label_colors.sql
-- Labels get a display color for pill rendering in the UI.

BEGIN;

ALTER TABLE labels ADD COLUMN color text;

COMMIT;
