-- 0001_initial_email_schema.sql
-- Core email service schema for Cookie (users, threads, messages,
-- attachments, labels). AI tables (todos, topics, embeddings) will be
-- added in a later migration.

BEGIN;

-- Identity (maps to Auth0)
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth0_sub   text UNIQUE NOT NULL,          -- e.g. 'google-oauth2|123...'
  email       text NOT NULL,
  name        text,
  picture_url text,
  prefs       jsonb NOT NULL DEFAULT '{}',   -- settings-modal preferences
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Conversation grouping
CREATE TABLE threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject         text,
  last_message_at timestamptz NOT NULL,      -- inbox sort key
  message_count   int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX threads_inbox_idx ON threads (user_id, last_message_at DESC);

-- One row per email
CREATE TABLE messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_name     text,
  from_address  text NOT NULL,
  recipients    jsonb NOT NULL DEFAULT '{}', -- {"to": [], "cc": [], "bcc": []}
  subject       text,
  snippet       text,                        -- first ~140 chars for list rows
  body_text     text,
  body_html_url text,                        -- large HTML stored in Vercel Blob
  raw_mime_url  text,                        -- original RFC 822 stored in Blob
  sent_at       timestamptz NOT NULL,
  is_unread     boolean NOT NULL DEFAULT true,
  is_starred    boolean NOT NULL DEFAULT false,
  is_archived   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  search        tsvector GENERATED ALWAYS AS (
                  to_tsvector('english',
                    coalesce(subject, '') || ' ' || coalesce(body_text, ''))
                ) STORED
);

CREATE INDEX messages_thread_idx ON messages (thread_id, sent_at);
CREATE INDEX messages_unread_idx ON messages (user_id) WHERE is_unread;
CREATE INDEX messages_search_idx ON messages USING gin (search);

-- Attachments (bytes live in Vercel Blob; rows hold metadata + URL)
CREATE TABLE attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename     text NOT NULL,
  content_type text,
  size_bytes   bigint,
  blob_url     text NOT NULL                 -- Vercel Blob (private access)
);

CREATE INDEX attachments_message_idx ON attachments (message_id);

-- Labels, many-to-many with messages
CREATE TABLE labels (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    text NOT NULL,
  kind    text NOT NULL DEFAULT 'user'
          CHECK (kind IN ('system', 'user')), -- 'system': Inbox, Spam, ...
  UNIQUE (user_id, name)
);

CREATE TABLE message_labels (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id   uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);

CREATE INDEX message_labels_label_idx ON message_labels (label_id);

COMMIT;
