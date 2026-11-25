-- 0007_label_descriptions.sql
-- Labels get an optional description, shown in the settings Labels manager
-- (and available to future auto-labelling rules).

BEGIN;

ALTER TABLE labels ADD COLUMN description text;

COMMIT;
