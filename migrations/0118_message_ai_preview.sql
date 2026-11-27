BEGIN;

-- The line Cookie-Web's mail list shows under a subject: a sentence or two,
-- written by mail-app-ingest's classifier in the same request that labels the
-- message, saying what the subject line leaves out. NULL for sent mail, for
-- mail classified before this column existed and when the model had nothing
-- to add; the list then falls back to messages.snippet. Kept apart from the
-- older message_ai.summary column, which still holds a few long summaries
-- from the reader.
ALTER TABLE public.message_ai
  ADD COLUMN preview text;

COMMIT;
