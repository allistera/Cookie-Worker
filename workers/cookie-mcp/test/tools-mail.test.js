import { describe, expect, test } from 'vitest';
import { ToolInputError } from '../src/results.js';
import { tools } from '../src/tools/mail.js';
import { byName, fakeApi } from './helpers.js';

const ID = '11111111-1111-4111-8111-111111111111';

/** @param {string} name @param {any} args @param {any} api */
function call(name, args, api) {
  const tool = byName(tools, name);
  return tool.run(tool.inputSchema.parse(args), api);
}

const row = {
  id: ID,
  from_name: 'Ann',
  from_address: 'ann@example.com',
  recipients: { to: [{ address: 'me@example.com' }] },
  subject: 'Hi',
  snippet: 'snip',
  sent_at: '2026-10-01T10:00:00Z',
  is_unread: true,
  is_starred: false,
  is_archived: false,
  scheduled_for: null,
  labels: [{ id: 'l1', name: 'Work' }],
  has_attachments: true,
};
const summary = {
  id: ID,
  from: { name: 'Ann', address: 'ann@example.com' },
  to: [{ address: 'me@example.com' }],
  subject: 'Hi',
  snippet: 'snip',
  sentAt: '2026-10-01T10:00:00Z',
  unread: true,
  starred: false,
  done: false,
  snoozedUntil: null,
  labels: ['Work'],
  hasAttachments: true,
};

describe('mail tools', () => {
  test('cookie_list_emails passes defaults and summarises rows', async () => {
    const api = fakeApi();
    api.emails.get.mockResolvedValue({ emails: [row], nextCursor: 'c2' });
    const result = await call('cookie_list_emails', {}, api);
    expect(api.emails.get).toHaveBeenCalledWith('/emails', {
      folder: 'inbox',
      label: undefined,
      limit: 25,
      before: undefined,
    });
    expect(result).toEqual({ emails: [summary], nextCursor: 'c2' });
  });

  test('cookie_list_emails requires a label name for the label folder', async () => {
    const api = fakeApi();
    await expect(call('cookie_list_emails', { folder: 'label' }, api)).rejects.toBeInstanceOf(
      ToolInputError,
    );
    expect(api.emails.get).not.toHaveBeenCalled();
  });

  test('cookie_list_emails forwards label and cursor', async () => {
    const api = fakeApi();
    api.emails.get.mockResolvedValue({ emails: [] });
    const result = await call(
      'cookie_list_emails',
      { folder: 'label', label: 'Work', cursor: 'abc' },
      api,
    );
    expect(api.emails.get).toHaveBeenCalledWith('/emails', {
      folder: 'label',
      label: 'Work',
      limit: 25,
      before: 'abc',
    });
    expect(result).toEqual({ emails: [], nextCursor: null });
  });

  const thread = [
    { id: 'other', from_name: 'X', from_address: 'x@e.com', snippet: 's', sent_at: 't0' },
    {
      id: ID,
      from_name: 'Ann',
      from_address: 'ann@example.com',
      snippet: 'snip',
      sent_at: '2026-10-01T10:00:00Z',
      is_sent: false,
    },
  ];
  const message = {
    id: ID,
    thread_id: 'th1',
    subject: 'Quarterly numbers',
    body_text: 'Hello there',
    body_html: '<p>Hello</p>',
    thread_summary: 'sum',
    thread,
    attachments: [{ id: 'a1', filename: 'f.pdf', content_type: 'application/pdf', size_bytes: 5 }],
    unsubscribe: 'mailto:x',
  };

  test('cookie_get_message maps the message and thread', async () => {
    const api = fakeApi();
    api.messages.get.mockResolvedValue(message);
    const result = await call('cookie_get_message', { id: ID }, api);
    expect(api.messages.get).toHaveBeenCalledWith('/messages', { id: ID });
    expect(result).toEqual({
      id: ID,
      threadId: 'th1',
      subject: 'Quarterly numbers',
      from: { name: 'Ann', address: 'ann@example.com' },
      sentAt: '2026-10-01T10:00:00Z',
      text: 'Hello there',
      truncated: false,
      hasHtml: true,
      threadSummary: 'sum',
      thread: [
        {
          id: 'other',
          fromName: 'X',
          fromAddress: 'x@e.com',
          snippet: 's',
          sentAt: 't0',
          isSent: undefined,
        },
        {
          id: ID,
          fromName: 'Ann',
          fromAddress: 'ann@example.com',
          snippet: 'snip',
          sentAt: '2026-10-01T10:00:00Z',
          isSent: false,
        },
      ],
      attachments: [{ id: 'a1', filename: 'f.pdf', contentType: 'application/pdf', sizeBytes: 5 }],
      canUnsubscribe: true,
    });
    const schema = byName(tools, 'cookie_get_message').outputSchema;
    expect(schema.parse(result)).toEqual(result);
  });

  test('cookie_get_message falls back to HTML text when body_text is null', async () => {
    const api = fakeApi();
    api.messages.get.mockResolvedValue({
      ...message,
      body_text: null,
      body_html: '<p>Hi &amp; bye</p>',
      unsubscribe: null,
    });
    const result = await call('cookie_get_message', { id: ID }, api);
    expect(result.text).toBe('Hi & bye');
    expect(result.hasHtml).toBe(true);
    expect(result.canUnsubscribe).toBe(false);
  });

  test('cookie_get_message flags truncated long bodies and omits missing sender', async () => {
    const api = fakeApi();
    api.messages.get.mockResolvedValue({
      ...message,
      body_text: 'a'.repeat(25_000),
      body_html: null,
      thread: [],
    });
    const result = await call('cookie_get_message', { id: ID }, api);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(20_000);
    expect(result.hasHtml).toBe(false);
    expect(result.from).toBeUndefined();
  });

  test('cookie_search_mail uses hybrid by default and paginates', async () => {
    const api = fakeApi();
    api.search.get.mockResolvedValue({ results: [row], estimatedTotalHits: 5 });
    const result = await call('cookie_search_mail', { query: 'from:ann' }, api);
    expect(api.search.get).toHaveBeenCalledWith('/search', {
      q: 'from:ann',
      scope: 'mail',
      mode: undefined,
      pagination: undefined,
      limit: 20,
      offset: 0,
    });
    // All five raw hits fit in the requested page (four were stale), so
    // there is no next page even though only one row came back.
    expect(result).toEqual({ results: [summary], estimatedTotalHits: 5, nextOffset: null });
  });

  test('cookie_search_mail advances hybrid pages by the requested limit, not hydrated rows', async () => {
    const api = fakeApi();
    api.search.get.mockResolvedValue({ results: [row], estimatedTotalHits: 30 });
    const result = await call('cookie_search_mail', { query: 'x', limit: 10, offset: 10 }, api);
    expect(result.nextOffset).toBe(20);
  });

  test('cookie_search_mail moves past a page that hydrates no rows', async () => {
    const api = fakeApi();
    api.search.get.mockResolvedValue({ results: [], estimatedTotalHits: 30 });
    const result = await call('cookie_search_mail', { query: 'x', limit: 10, offset: 10 }, api);
    expect(result.results).toEqual([]);
    expect(result.nextOffset).toBe(20);
  });

  test('cookie_search_mail keyword mode uses verified pagination and its raw-hit cursor', async () => {
    const api = fakeApi();
    api.search.get.mockResolvedValue({
      results: [row, row],
      estimatedTotalHits: 40,
      nextOffset: 7,
    });
    const result = await call(
      'cookie_search_mail',
      { query: 'x', mode: 'keyword', limit: 2, offset: 2 },
      api,
    );
    expect(api.search.get.mock.calls[0][1]).toMatchObject({
      mode: 'keyword',
      pagination: 'verified',
      offset: 2,
    });
    expect(result.nextOffset).toBe(7);
  });

  test('cookie_search_mail keyword mode and null nextOffset on the last page', async () => {
    const api = fakeApi();
    api.search.get.mockResolvedValue({
      results: [row, row],
      estimatedTotalHits: 4,
      nextOffset: null,
    });
    const result = await call(
      'cookie_search_mail',
      { query: 'x', mode: 'keyword', offset: 2 },
      api,
    );
    expect(result.nextOffset).toBeNull();
  });

  test('cookie_search_mail hands over to raw-hit paging past the verified scan cap', async () => {
    const api = fakeApi();
    api.search.get.mockResolvedValue({
      results: [],
      estimatedTotalHits: 5000,
      nextOffset: null,
      scanLimitReached: true,
    });
    const first = await call(
      'cookie_search_mail',
      { query: 'x', mode: 'keyword', offset: 990 },
      api,
    );
    expect(first.nextOffset).toBe(1000);

    api.search.get.mockResolvedValue({ results: [row], estimatedTotalHits: 5000 });
    const second = await call(
      'cookie_search_mail',
      { query: 'x', mode: 'keyword', limit: 20, offset: 1000 },
      api,
    );
    expect(api.search.get.mock.calls[1][1]).toMatchObject({ pagination: undefined, offset: 1000 });
    expect(second.nextOffset).toBe(1020);
  });

  test('cookie_search_mail never returns a nextOffset at or before offset', async () => {
    const api = fakeApi();
    api.search.get.mockResolvedValue({ results: [], estimatedTotalHits: 40, nextOffset: 5 });
    const result = await call(
      'cookie_search_mail',
      { query: 'x', mode: 'keyword', offset: 5 },
      api,
    );
    expect(result.nextOffset).toBeNull();
  });

  test('cookie_search_mail documents the operators', () => {
    const { description } = byName(tools, 'cookie_search_mail');
    for (const op of [
      'from:',
      'to:',
      'tag:<label>',
      'has:attachment',
      'before:YYYY-MM-DD',
      'after:YYYY-MM-DD',
      'in:inbox|sent|spam|snoozed|done|all',
      'is:starred',
      'quoted phrases',
    ])
      expect(description).toContain(op);
  });

  test('cookie_ask_mail posts the question and maps sources', async () => {
    const api = fakeApi();
    api.search.post.mockResolvedValue({
      answer: 'Tuesday',
      sources: [{ id: ID, subject: 'Hi', from_name: 'Ann' }],
    });
    const result = await call('cookie_ask_mail', { question: 'When?' }, api);
    expect(api.search.post).toHaveBeenCalledWith('/ask', { question: 'When?' });
    expect(result).toEqual({
      answer: 'Tuesday',
      sources: [{ messageId: ID, subject: 'Hi', from: 'Ann' }],
    });
  });

  test('cookie_list_contacts filters case-insensitively, limits and totals', async () => {
    const api = fakeApi();
    api.messages.get.mockResolvedValue({
      contacts: [
        { address: 'ann@example.com', name: 'Ann' },
        { address: 'bob@example.com', name: 'Bob' },
        { address: 'joanna@x.org', name: null },
      ],
    });
    const result = await call('cookie_list_contacts', { query: 'ANN', limit: 1 }, api);
    expect(api.messages.get).toHaveBeenCalledWith('/messages/contacts');
    expect(result).toEqual({
      contacts: [{ address: 'ann@example.com', name: 'Ann' }],
      total: 2,
    });
  });
});
