import { describe, expect, test } from 'vitest';
import {
  autoReplySuppression,
  localDate,
  normaliseAddress,
  outOfOfficeError,
  outOfOfficeSettings,
  outOfOfficeStatus,
} from '../outOfOffice.js';

const settings = {
  revision: 1,
  enabled: true,
  startDate: '2026-10-25',
  endDate: '2026-10-25',
  timeZone: 'Europe/London',
  subject: 'Away',
  text: 'I will reply when I return.',
  activatedAt: '2026-10-24T10:00:00Z',
};
const message = {
  id: 'message',
  created_at: '2026-10-25T01:15:00Z',
  out_of_office_revision: 1,
  from_address: 'sender@example.com',
  envelope_from: 'sender@example.com',
  envelope_to: 'mail@example.com',
  recipients: { to: [{ address: 'mail@example.com' }], cc: [] },
  owner_email: 'owner@example.com',
  headers: [],
  ai_status: 'completed',
  spam_verdict: 'inbox',
  is_sent: false,
  is_deleted: false,
};
const from = 'Cookie <mail@example.com>';
const now = '2026-10-25T12:00:00Z';
const reason = (changes = {}, prefs = settings) =>
  autoReplySuppression({ ...message, ...changes }, prefs, from, now);

describe('dated out-of-office settings', () => {
  test('defaults safely to disabled and validates impossible dates, zones and header injection', () => {
    expect(outOfOfficeSettings(null).enabled).toBe(false);
    expect(outOfOfficeError(settings)).toBeNull();
    expect(outOfOfficeError({ ...settings, startDate: '2026-02-30' })).toContain('real');
    expect(outOfOfficeError({ ...settings, endDate: '2026-10-24' })).toContain('on or after');
    expect(outOfOfficeError({ ...settings, timeZone: 'Not/AZone' })).toContain('timezone');
    expect(outOfOfficeError({ ...settings, timeZone: '+01:00' })).toContain('timezone');
    expect(
      outOfOfficeError({ ...settings, subject: 'Away\r\nBcc: intruder@example.com' }),
    ).toContain('control');
  });
  test('includes both repeated DST hours and the inclusive end midnight boundary', () => {
    expect(localDate('2026-10-24T23:00:00Z', settings.timeZone)).toBe('2026-10-25');
    expect(outOfOfficeStatus(settings, '2026-10-24T22:59:59Z')).toBe('scheduled');
    for (const instant of [
      '2026-10-24T23:00:00Z',
      '2026-10-25T00:30:00Z',
      '2026-10-25T01:30:00Z',
      '2026-10-25T23:59:59Z',
    ])
      expect(outOfOfficeStatus(settings, instant)).toBe('active');
    expect(outOfOfficeStatus(settings, '2026-10-26T00:00:00Z')).toBe('expired');
  });
  test('uses actual local dates across the short spring DST day', () => {
    const spring = { ...settings, startDate: '2026-03-29', endDate: '2026-03-29' };
    expect(outOfOfficeStatus(spring, '2026-03-29T22:59:59Z')).toBe('active');
    expect(outOfOfficeStatus(spring, '2026-03-29T23:00:00Z')).toBe('expired');
  });
});

describe('eligibility fails closed', () => {
  test('uses database arrival time and the enabled revision, never sent_at or a later enable', () => {
    expect(reason({ sent_at: '1900-01-01' })).toBeNull();
    expect(reason({ created_at: '2026-10-24T09:59:59Z' })).toBe('outside_activation');
    expect(reason({ out_of_office_revision: null })).toBe('revision_changed');
    expect(reason({}, { ...settings, revision: 2 })).toBe('revision_changed');
    expect(reason({}, { ...settings, enabled: false })).toBe('inactive');
    expect(reason({ created_at: '2026-10-24T12:00:00Z' })).toBe('outside_window');
  });
  test.each([null, 'pending', 'failed'])(
    'requires completed classification, not %s',
    (ai_status) => {
      expect(reason({ ai_status })).toBe('unclassified_or_spam');
    },
  );
  test.each([
    [{ spam_verdict: 'spam' }, 'unclassified_or_spam'],
    [{ spam_verdict: null }, 'unclassified_or_spam'],
    [{ auto_reply_suppressed: true }, 'screened'],
    [{ screening_status: 'blocked' }, 'screened'],
    [{ screening_status: 'pending' }, 'screened'],
    [{ is_deleted: true }, 'not_inbound'],
    [{ is_sent: true }, 'not_inbound'],
    [{ envelope_from: '<>' }, 'invalid_or_null_sender'],
    [{ envelope_from: '' }, 'invalid_or_null_sender'],
    [{ envelope_from: 'mail@example.com' }, 'self'],
    [{ from_address: 'OWNER@example.com' }, 'self'],
    [{ envelope_from: 'no-reply@example.com' }, 'automated_sender'],
    [{ headers: null }, 'missing_headers'],
    [
      { recipients: { to: [], cc: [], bcc: [{ address: 'mail@example.com' }] } },
      'not_addressed_to_mailbox',
    ],
    [{ recipients: { to: [{ address: 'someone-else@example.com' }] } }, 'not_addressed_to_mailbox'],
  ])('suppresses unsafe arrival %j', (changes, expected) => expect(reason(changes)).toBe(expected));
  test.each([
    ['Auto-Submitted', 'auto-replied'],
    ['Auto-Submitted', 'auto-generated'],
    ['X-Auto-Response-Suppress', 'All'],
    ['List-Id', 'list.example.com'],
    ['List-Unsubscribe', '<https://example.com>'],
    ['Precedence', 'bulk'],
    ['Precedence', 'list'],
    ['X-Loop', 'anything'],
    ['X-Autoreply', 'yes'],
    ['Content-Type', 'multipart/report; report-type=delivery-status'],
    ['Return-Path', '<>'],
  ])('suppresses loop/list header %s', (key, value) => {
    expect(reason({ headers: [{ key, value }] })).not.toBeNull();
  });
  test('accepts ordinary mail and normalizes only the address case/whitespace', () => {
    expect(reason({ headers: [{ key: 'Auto-Submitted', value: 'no' }] })).toBeNull();
    expect(reason({ recipients: { to: [], cc: [{ address: 'MAIL@example.com' }] } })).toBeNull();
    expect(normaliseAddress(' Sender+tag@Example.COM ')).toBe('sender+tag@example.com');
    expect(normaliseAddress('sender@example.com\r\nBcc: other@example.com')).toBeNull();
  });
});
