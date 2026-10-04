import { describe, expect, test } from 'vitest';
import { ApiError } from '../src/api.js';
import { ToolInputError } from '../src/results.js';
import { tools } from '../src/tools/drafts.js';
import { byName, fakeApi } from './helpers.js';

const ID = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';
const ATT = '33333333-3333-4333-8333-333333333333';

/** @param {string} name @param {any} args @param {any} api */
async function call(name, args, api) {
  const tool = byName(tools, name);
  const result = await tool.run(tool.inputSchema.parse(args), api);
  tool.outputSchema.parse(result);
  return result;
}

const listRow = {
  id: ID,
  to: 'ann@example.com',
  subject: 'Hi',
  preview: 'hello',
  replyToMessageId: null,
  updatedAt: '2026-10-01T10:00:00.000Z',
  isAiGenerated: false,
  isSummary: false,
  attachmentCount: 1,
};
const fullDraft = {
  id: ID,
  to: 'ann@example.com, bob@example.com',
  subject: 'Hi',
  text: 'Hello there',
  html: '<p>Hello there</p>',
  replyToMessageId: MSG,
  followUpAt: '2026-10-08T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  isAiGenerated: false,
  attachments: [
    {
      id: ATT,
      filename: 'a.pdf',
      content_type: 'application/pdf',
      size_bytes: 10,
      source: 'upload',
    },
  ],
};

describe('drafts tools', () => {
  test('cookie_list_drafts returns the draft rows', async () => {
    const api = fakeApi();
    api.drafts.get.mockResolvedValue({ drafts: [listRow] });
    const result = await call('cookie_list_drafts', {}, api);
    expect(api.drafts.get).toHaveBeenCalledWith('/drafts');
    expect(result).toEqual({ drafts: [listRow] });
  });

  test('cookie_get_draft truncates text and reports html presence', async () => {
    const api = fakeApi();
    api.drafts.get.mockResolvedValue({ draft: { ...fullDraft, text: 'a'.repeat(25_000) } });
    const result = await call('cookie_get_draft', { id: ID }, api);
    expect(api.drafts.get).toHaveBeenCalledWith(`/drafts/${ID}`);
    expect(result.draft.text).toHaveLength(20_000);
    expect(result.draft.truncated).toBe(true);
    expect(result.draft.hasHtml).toBe(true);
    expect(result.draft.html).toBeUndefined();
    expect(result.draft.attachments).toEqual(fullDraft.attachments);
  });

  test('cookie_save_draft without id creates a draft with a joined recipient string', async () => {
    const api = fakeApi();
    api.drafts.post.mockResolvedValue({ draft: { id: ID, updatedAt: 'u1' } });
    const result = await call(
      'cookie_save_draft',
      { to: ['a@example.com', 'b@example.com'], subject: 'S', text: 'T' },
      api,
    );
    expect(api.drafts.post).toHaveBeenCalledWith('/drafts', {
      to: 'a@example.com, b@example.com',
      subject: 'S',
      text: 'T',
    });
    expect(api.drafts.get).not.toHaveBeenCalled();
    expect(result).toEqual({ draft: { id: ID, updatedAt: 'u1' } });
  });

  test('cookie_save_draft with id merges over the existing draft and keeps attachments', async () => {
    const api = fakeApi();
    api.drafts.get.mockResolvedValue({ draft: fullDraft });
    api.drafts.patch.mockResolvedValue({ draft: { id: ID, updatedAt: 'u2' } });
    const result = await call('cookie_save_draft', { id: ID, subject: 'New subject' }, api);
    expect(api.drafts.get).toHaveBeenCalledWith(`/drafts/${ID}`);
    expect(api.drafts.patch).toHaveBeenCalledWith(`/drafts/${ID}`, {
      to: 'ann@example.com, bob@example.com',
      subject: 'New subject',
      text: 'Hello there',
      html: '<p>Hello there</p>',
      replyToMessageId: MSG,
      followUpAt: '2026-10-08T10:00:00.000Z',
      attachmentIds: [ATT],
      expectedUpdatedAt: '2026-10-01T10:00:00.000Z',
    });
    expect(result).toEqual({ draft: { id: ID, updatedAt: 'u2' } });
  });

  test('cookie_save_draft with id lets provided to array and nulls override', async () => {
    const api = fakeApi();
    api.drafts.get.mockResolvedValue({ draft: fullDraft });
    api.drafts.patch.mockResolvedValue({ draft: { id: ID, updatedAt: 'u2' } });
    await call(
      'cookie_save_draft',
      { id: ID, to: ['c@example.com'], replyToMessageId: null, followUpAt: null },
      api,
    );
    expect(api.drafts.patch.mock.calls[0][1]).toMatchObject({
      to: 'c@example.com',
      replyToMessageId: null,
      followUpAt: null,
      text: 'Hello there',
    });
  });

  test('cookie_save_draft clears the stored html when only text changes', async () => {
    const api = fakeApi();
    api.drafts.get.mockResolvedValue({ draft: fullDraft });
    api.drafts.patch.mockResolvedValue({ draft: { id: ID, updatedAt: 'u2' } });
    await call('cookie_save_draft', { id: ID, text: 'New body' }, api);
    expect(api.drafts.patch.mock.calls[0][1]).toMatchObject({ text: 'New body', html: null });
  });

  test('cookie_save_draft keeps a provided html alongside new text', async () => {
    const api = fakeApi();
    api.drafts.get.mockResolvedValue({ draft: fullDraft });
    api.drafts.patch.mockResolvedValue({ draft: { id: ID, updatedAt: 'u2' } });
    await call('cookie_save_draft', { id: ID, text: 'New body', html: '<p>New body</p>' }, api);
    expect(api.drafts.patch.mock.calls[0][1]).toMatchObject({
      text: 'New body',
      html: '<p>New body</p>',
    });
  });

  test('cookie_save_draft description says text without html clears the formatted body', () => {
    expect(byName(tools, 'cookie_save_draft').description).toMatch(
      /changing text without html clears the formatted body/i,
    );
  });

  test('cookie_save_draft refuses a merge that would empty (and so delete) the draft', async () => {
    const api = fakeApi();
    api.drafts.get.mockResolvedValue({
      draft: { ...fullDraft, to: '', subject: '', text: '', attachments: [] },
    });
    const tool = byName(tools, 'cookie_save_draft');
    await expect(tool.run(tool.inputSchema.parse({ id: ID }), api)).rejects.toThrow(ToolInputError);
    expect(api.drafts.patch).not.toHaveBeenCalled();
  });

  test('cookie_save_draft surfaces a 409 from PATCH as ApiError', async () => {
    const api = fakeApi();
    api.drafts.get.mockResolvedValue({ draft: fullDraft });
    api.drafts.patch.mockRejectedValue(new ApiError('drafts', 409, 'Conflict'));
    const tool = byName(tools, 'cookie_save_draft');
    await expect(
      tool.run(tool.inputSchema.parse({ id: ID, text: 'x' }), api),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test('cookie_delete_draft deletes by id', async () => {
    const api = fakeApi();
    api.drafts.delete.mockResolvedValue(null);
    const result = await call('cookie_delete_draft', { id: ID }, api);
    expect(api.drafts.delete).toHaveBeenCalledWith(`/drafts/${ID}`);
    expect(result).toEqual({ deleted: true, id: ID });
  });

  test('cookie_send_email sends immediately and omits undefined fields', async () => {
    const api = fakeApi();
    api.send.post.mockResolvedValue({ id: 'prov', messageId: '<m@x>', followUpScheduled: true });
    const result = await call(
      'cookie_send_email',
      { to: ['a@example.com', 'b@example.com'], subject: 'S', text: 'T', requestId: 'req-1' },
      api,
    );
    expect(api.send.post).toHaveBeenCalledWith('/send', {
      to: 'a@example.com, b@example.com',
      subject: 'S',
      text: 'T',
      requestId: 'req-1',
    });
    expect(result).toEqual({
      status: 'sent',
      providerId: 'prov',
      messageId: '<m@x>',
      followUpScheduled: true,
    });
  });

  test('cookie_send_email accepts a null stored message id on a delivered send', async () => {
    const api = fakeApi();
    // The send worker returns messageId null when the sent copy fails to store.
    api.send.post.mockResolvedValue({ id: 'prov', messageId: null });
    const result = await call(
      'cookie_send_email',
      { to: ['a@example.com'], subject: 'S', text: 'T' },
      api,
    );
    expect(result).toEqual({ status: 'sent', providerId: 'prov', messageId: null });
  });

  test('cookie_send_email with sendAt returns the scheduled send', async () => {
    const api = fakeApi();
    const scheduledSend = {
      id: ID,
      toAddresses: 'a@example.com',
      subject: 'S',
      scheduledFor: '2026-10-05T09:00:00.000Z',
      followUpAt: null,
    };
    api.send.post.mockResolvedValue({ scheduledSend });
    const result = await call(
      'cookie_send_email',
      { to: ['a@example.com'], subject: 'S', text: 'T', sendAt: '2026-10-05T09:00:00Z' },
      api,
    );
    expect(api.send.post.mock.calls[0][1].sendAt).toBe('2026-10-05T09:00:00Z');
    expect(result).toEqual({ status: 'scheduled', scheduledSend });
  });

  test('cookie_send_email rejects bad input', () => {
    const tool = byName(tools, 'cookie_send_email');
    const base = { to: ['a@example.com'], subject: 'S', text: 'T' };
    expect(() => tool.inputSchema.parse({ ...base, to: [] })).toThrow();
    expect(() => tool.inputSchema.parse({ ...base, to: ['nope'] })).toThrow();
    expect(() => tool.inputSchema.parse({ ...base, text: '' })).toThrow();
    expect(() => tool.inputSchema.parse({ ...base, requestId: 'bad id!' })).toThrow();
  });

  test('cookie_list_scheduled returns scheduled sends', async () => {
    const api = fakeApi();
    const row = {
      id: ID,
      toAddresses: 'a@example.com',
      subject: 'S',
      scheduledFor: '2026-10-05T09:00:00.000Z',
      followUpAt: null,
    };
    api.send.get.mockResolvedValue({ scheduledSends: [row] });
    const result = await call('cookie_list_scheduled', {}, api);
    expect(api.send.get).toHaveBeenCalledWith('/send/scheduled');
    expect(result).toEqual({ scheduledSends: [row] });
  });

  test('cookie_cancel_scheduled deletes with the id in the body', async () => {
    const api = fakeApi();
    const scheduledSend = { id: ID, subject: 'S' };
    api.send.delete.mockResolvedValue({ scheduledSend });
    const result = await call('cookie_cancel_scheduled', { id: ID }, api);
    expect(api.send.delete).toHaveBeenCalledWith('/send/scheduled', { id: ID });
    expect(result).toEqual({ cancelled: true, scheduledSend });
  });
});
