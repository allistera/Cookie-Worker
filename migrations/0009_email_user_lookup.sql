-- 0009_email_user_lookup.sql
-- API lookups now key on users.email (from the access token's email claim)
-- instead of users.auth0_sub, so logins survive Auth0 connection changes —
-- the Google -> database email/password cutover changed the sub from
-- 'google-oauth2|...' to 'auth0|...', orphaning the mailbox. Point the
-- single user record at the mailbox owner's address and enforce the
-- uniqueness the new lookup relies on.
--
-- Guarded so a fresh replay never hands this address to someone else's
-- account: it only touches the lone, pre-cutover (Google-linked) user row
-- that production had when this ran, and is a no-op anywhere else.

BEGIN;

UPDATE users SET email = 'allisteraall@gmail.com'
WHERE auth0_sub LIKE 'google-oauth2|%'
  AND (SELECT count(*) FROM users) = 1;

CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

COMMIT;
