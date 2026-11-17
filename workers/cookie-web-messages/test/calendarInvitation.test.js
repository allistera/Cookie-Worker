import { describe, expect, test, vi } from 'vitest';
import { extractCalendarDetails, parseCalendarInvitation } from '../src/calendarInvite.js';

/** @param {string} method @param {string[]} lines */
function calendar(method, lines) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Example//Calendar//EN',
    ...(method ? [`METHOD:${method}`] : []),
    ...lines,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const SERIES = [
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/London:20261201T100000',
  'DTEND;TZID=Europe/London:20261201T110000',
  'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270101T000000Z',
  'DTSTAMP:20261117T090000Z',
  'ORGANIZER;CN=Olive Organiser:mailto:olive@example.com',
  'UID:team-sync@calendar.example',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=',
  ' TRUE;CN=me@cookie.test;X-NUM-GUESTS=0:mailto:Me@Cookie.test',
  'ATTENDEE;PARTSTAT=ACCEPTED;CN=Olive Organiser:MAILTO:olive@example.com',
  'SEQUENCE:2',
  'STATUS:CONFIRMED',
  'SUMMARY;LANGUAGE=en-GB:Team sync',
  'LOCATION:Room 4',
  'END:VEVENT',
];
const MOVED_OCCURRENCE = [
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/New_York:20261208T140000',
  'DTEND;TZID=America/New_York:20261208T150000',
  'RECURRENCE-ID;TZID=America/New_York:20261208T100000',
  'DTSTAMP:20261118T090000Z',
  'ORGANIZER;CN=Olive Organiser:mailto:olive@example.com',
  'UID:team-sync@calendar.example',
  'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@cookie.test',
  'SEQUENCE:3',
  'SUMMARY:Team sync (moved)',
  'END:VEVENT',
];

describe('parseCalendarInvitation', () => {
  test('keeps what identifies a request and who it is between', () => {
    expect(parseCalendarInvitation(calendar('REQUEST', SERIES))).toEqual({
      method: 'request',
      uid: 'team-sync@calendar.example',
      recurrenceId: '',
      sequence: 2,
      dtstamp: '2026-11-17T09:00:00.000Z',
      organizer: { address: 'olive@example.com', name: 'Olive Organiser' },
      attendees: [
        // Google repeats the address as the name of a guest without one.
        { address: 'me@cookie.test', name: null },
        { address: 'olive@example.com', name: 'Olive Organiser' },
      ],
      title: 'Team sync',
      description: null,
      location: 'Room 4',
      startAt: '2026-12-01T10:00:00.000Z',
      endAt: '2026-12-01T11:00:00.000Z',
      allDay: false,
      recurrenceRule: 'FREQ=WEEKLY;UNTIL=20270101T000000Z;BYDAY=TU',
      timeZone: 'Europe/London',
    });
  });

  test('tracks the series when a message carries it with a changed occurrence', () => {
    const parsed = parseCalendarInvitation(calendar('REQUEST', [...MOVED_OCCURRENCE, ...SERIES]));
    expect(parsed).toMatchObject({ recurrenceId: '', sequence: 2, title: 'Team sync' });
  });

  test('identifies one occurrence by its original start in UTC', () => {
    // 10:00 in New York on 8 December is 15:00 UTC.
    expect(parseCalendarInvitation(calendar('REQUEST', MOVED_OCCURRENCE))).toMatchObject({
      recurrenceId: '20261208T150000Z',
      sequence: 3,
      startAt: '2026-12-08T19:00:00.000Z',
      recurrenceRule: null,
      timeZone: 'America/New_York',
    });
  });

  test('reads an all-day invitation as whole days with an exclusive end', () => {
    const parsed = parseCalendarInvitation(
      calendar('REQUEST', [
        'BEGIN:VEVENT',
        'UID:offsite',
        'DTSTAMP:20261117T090000Z',
        'DTSTART;VALUE=DATE:20261224',
        'DTEND;VALUE=DATE:20261226',
        'RECURRENCE-ID;VALUE=DATE:20261223',
        'ORGANIZER:mailto:olive@example.com',
        'ATTENDEE:mailto:me@cookie.test',
        'SUMMARY:Offsite',
        'END:VEVENT',
      ]),
    );
    expect(parsed).toMatchObject({
      allDay: true,
      startAt: '2026-12-24T00:00:00.000Z',
      endAt: '2026-12-26T00:00:00.000Z',
      recurrenceId: '20261223',
      sequence: 0,
      timeZone: null,
    });
  });

  test('gives an all-day invitation without an end one day', () => {
    const parsed = parseCalendarInvitation(
      calendar('REQUEST', [
        'BEGIN:VEVENT',
        'UID:birthday',
        'DTSTART;VALUE=DATE:20261224',
        'ORGANIZER:mailto:olive@example.com',
        'SUMMARY:Birthday',
        'END:VEVENT',
      ]),
    );
    expect(parsed).toMatchObject({ endAt: '2026-12-25T00:00:00.000Z', dtstamp: null });
    expect(parsed?.attendees).toEqual([]);
  });

  test('takes the length of a timed event from DURATION, or an hour without either', () => {
    const event = (/** @type {string[]} */ extra) =>
      calendar('REQUEST', [
        'BEGIN:VEVENT',
        'UID:call',
        'DTSTART:20261201T100000Z',
        ...extra,
        'ORGANIZER:mailto:olive@example.com',
        'SUMMARY:Call',
        'END:VEVENT',
      ]);
    expect(parseCalendarInvitation(event(['DURATION:PT90M']))?.endAt).toBe(
      '2026-12-01T11:30:00.000Z',
    );
    expect(parseCalendarInvitation(event([]))?.endAt).toBe('2026-12-01T11:00:00.000Z');
  });

  test.each([
    ['a CANCEL', 'CANCEL', ['STATUS:CANCELLED']],
    ['a REQUEST whose event is marked cancelled', 'REQUEST', ['STATUS:CANCELLED']],
  ])('reads %s as a cancellation', (_label, method, extra) => {
    const parsed = parseCalendarInvitation(
      calendar(method, [
        'BEGIN:VEVENT',
        'UID:gone',
        'DTSTAMP:20261117T090000Z',
        'DTSTART:20261201T100000Z',
        'DTEND:20261201T110000Z',
        'ORGANIZER:mailto:olive@example.com',
        'ATTENDEE:mailto:me@cookie.test',
        'SEQUENCE:4',
        ...extra,
        'SUMMARY:Gone',
        'END:VEVENT',
      ]),
    );
    expect(parsed).toMatchObject({ method: 'cancel', uid: 'gone', sequence: 4 });
  });

  test.each([
    ['a calendar file with no method', ''],
    ['a guest’s reply', 'REPLY'],
    ['a counter-proposal', 'COUNTER'],
    ['a published event', 'PUBLISH'],
  ])('does not treat %s as an invitation', (_label, method) => {
    expect(parseCalendarInvitation(calendar(method, SERIES))).toBeNull();
  });

  test.each([
    ['no UID', (/** @type {string} */ line) => !line.startsWith('UID:')],
    ['no organiser', (/** @type {string} */ line) => !line.startsWith('ORGANIZER')],
    ['no start', (/** @type {string} */ line) => !line.startsWith('DTSTART')],
  ])('ignores a request with %s', (_label, keep) => {
    expect(parseCalendarInvitation(calendar('REQUEST', SERIES.filter(keep)))).toBeNull();
  });

  test('ignores an organiser that is not a mail address, and a UID too long to store', () => {
    const lines = SERIES.map((line) =>
      line.startsWith('ORGANIZER') ? 'ORGANIZER:https://calendar.example/olive' : line,
    );
    expect(parseCalendarInvitation(calendar('REQUEST', lines))).toBeNull();
    const longUid = SERIES.map((line) =>
      line.startsWith('UID:') ? `UID:${'u'.repeat(501)}` : line,
    );
    expect(parseCalendarInvitation(calendar('REQUEST', longUid))).toBeNull();
  });

  test('returns null for text that is not a calendar', () => {
    expect(parseCalendarInvitation('not a calendar')).toBeNull();
  });
});

describe('extractCalendarDetails', () => {
  const attachment = (/** @type {string} */ text) => ({
    filename: 'invite.ics',
    content_type: 'text/calendar; method=REQUEST',
    size_bytes: new TextEncoder().encode(text).byteLength,
    downloadable: true,
    blob_url: 'https://store.private.blob.vercel-storage.com/invite.ics',
  });

  test('reads the attachment once for both the event offer and the invitation', async () => {
    const text = calendar('REQUEST', SERIES);
    const readBlob = vi.fn(async () => ({ stream: new Response(text).body }));
    const details = await extractCalendarDetails([attachment(text)], readBlob);

    expect(readBlob).toHaveBeenCalledOnce();
    expect(details.invite).toMatchObject({ title: 'Team sync' });
    expect(details.invitation).toMatchObject({ uid: 'team-sync@calendar.example' });
  });

  test('reports a cancellation as an invitation with no event to add', async () => {
    const text = calendar('CANCEL', [
      'BEGIN:VEVENT',
      'UID:gone',
      'DTSTART:20261201T100000Z',
      'DTEND:20261201T110000Z',
      'ORGANIZER:mailto:olive@example.com',
      'STATUS:CANCELLED',
      'SUMMARY:Gone',
      'END:VEVENT',
    ]);
    const details = await extractCalendarDetails([attachment(text)], async () => ({
      stream: new Response(text).body,
    }));
    expect(details.invite).toBeNull();
    expect(details.invitation).toMatchObject({ method: 'cancel' });
  });

  test('returns neither without a way to read the attachment', async () => {
    expect(await extractCalendarDetails([attachment('x')])).toEqual({
      invite: null,
      invitation: null,
    });
  });
});
