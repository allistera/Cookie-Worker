import { describe, expect, test } from 'vitest';
import { MESSAGES_INDEX } from '../meili/messages.js';

describe('message search document mapping', () => {
  test('normalizes an empty message into searchable defaults', () => {
    expect(MESSAGES_INDEX.toDocument({ id: 12, user_id: 34 })).toEqual({
      id: '12',
      user_id: '34',
      subject: '',
      body: '',
      from_name: '',
      from_address: '',
      to_address: [],
      to_name: [],
      labels: [],
      sent_at: 0,
      scheduled_for: 0,
      is_unread: false,
      is_starred: false,
      is_archived: false,
      is_sent: false,
      is_deleted: false,
      has_attachments: false,
      is_spam: false,
    });
  });

  test('indexes recipients from all envelopes while ignoring absent names and addresses', () => {
    const document = MESSAGES_INDEX.toDocument({
      id: 'message',
      user_id: 'owner',
      subject: 'Meeting',
      body_text: 'Agenda',
      from_name: 'Sender',
      from_address: 'sender@example.com',
      recipients: {
        to: ['one@example.com', { name: 'Two', address: 'two@example.com' }],
        cc: [null, {}, { name: 'Name only' }],
        bcc: [{ address: 'three@example.com' }, 'four@example.com'],
      },
      labels: [{ name: 'Work' }, { name: 123 }],
      sent_at: '2026-01-01T00:00:00.999Z',
      scheduled_for: '2026-01-02T00:00:00.999Z',
      is_unread: 1,
      is_starred: true,
      is_archived: true,
      is_sent: true,
      is_deleted: true,
      has_attachments: true,
      spam_verdict: 'spam',
    });
    expect(document).toEqual({
      id: 'message',
      user_id: 'owner',
      subject: 'Meeting',
      body: 'Agenda',
      from_name: 'Sender',
      from_address: 'sender@example.com',
      to_address: ['one@example.com', 'two@example.com', 'three@example.com', 'four@example.com'],
      to_name: ['Two', 'Name only'],
      labels: ['Work', '123'],
      sent_at: 1767225600,
      scheduled_for: 1767312000,
      is_unread: true,
      is_starred: true,
      is_archived: true,
      is_sent: true,
      is_deleted: true,
      has_attachments: true,
      is_spam: true,
    });
  });

  test.each(['held', 'blocked'])(
    'excludes %s messages from ordinary search',
    (screening_status) => {
      expect(MESSAGES_INDEX.toDocument({ id: 'message', screening_status }).is_deleted).toBe(true);
    },
  );

  test.each(['allowed', 'pending', undefined])(
    'keeps undeleted %s messages visible',
    (screening_status) => {
      expect(
        MESSAGES_INDEX.toDocument({ id: 'message', screening_status, spam_verdict: 'ham' }),
      ).toMatchObject({ is_deleted: false, is_spam: false });
    },
  );

  test.each([{ to: ['to@example.com'] }, { cc: ['cc@example.com'] }, { bcc: ['bcc@example.com'] }])(
    'accepts a partial recipient envelope %j',
    (recipients) => {
      expect(MESSAGES_INDEX.toDocument({ recipients }).to_address).toEqual(
        Object.values(recipients).flat(),
      );
    },
  );
});
