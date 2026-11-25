-- Auto Archive, the opt-in AI filing of marketing, cold pitches and social
-- noise, has been removed from Cookie-Web and the Workers: the same outcome
-- is configured through Rules with the "Mark done" action. The feature kept
-- its per-user category switches in users.prefs under autoArchive; drop that
-- key so no orphaned setting survives. Nothing reads it any more, so this
-- migration can run before or after the Worker and Cookie-Web deploys.
BEGIN;

UPDATE public.users SET prefs = prefs - 'autoArchive' WHERE prefs ? 'autoArchive';

COMMIT;
