import { describe, expect, test, vi } from 'vitest';
import { extractCalendarInvite, MAX_CALENDAR_ATTACHMENT_BYTES } from '../src/calendarInvite.js';

const LIVE_ICS = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:1292383\r
DTSTART:20260902T150000Z\r
DTEND:20260902T153000Z\r
SUMMARY:Whitburn Recycling Centre\r
DESCRIPTION:Booking confirmation\r
LOCATION:West Lothian Recycling Centre\r
STATUS:CONFIRMED\r
END:VEVENT\r
END:VCALENDAR\r
`;

/** @param {string | Uint8Array} value */
function streamOf(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function attachment(overrides = {}) {
  return {
    filename: 'Booking Reminder 1292383.ics',
    content_type: 'text/calendar',
    size_bytes: new TextEncoder().encode(LIVE_ICS).byteLength,
    downloadable: true,
    blob_url: 'https://store.private.blob.vercel-storage.com/calendar.ics',
    ...overrides,
  };
}

describe('extractCalendarInvite', () => {
  test('accepts PostgreSQL BIGINT attachment sizes returned as canonical strings', async () => {
    const readBlob = vi.fn().mockResolvedValue({ stream: streamOf(LIVE_ICS) });
    const result = await extractCalendarInvite([attachment({ size_bytes: '384' })], readBlob);

    expect(result?.start_at).toBe('2026-09-02T15:00:00.000Z');
    expect(readBlob).toHaveBeenCalledOnce();
  });

  test('normalizes the earliest timed VEVENT from a private ICS attachment', async () => {
    const readBlob = vi.fn().mockResolvedValue({ stream: streamOf(LIVE_ICS) });
    const result = await extractCalendarInvite([attachment()], readBlob);

    expect(result).toEqual({
      title: 'Whitburn Recycling Centre',
      description: 'Booking confirmation',
      location: 'West Lothian Recycling Centre',
      start_at: '2026-09-02T15:00:00.000Z',
      end_at: '2026-09-02T15:30:00.000Z',
    });
    expect(readBlob).toHaveBeenCalledWith(attachment().blob_url);
  });

  test('uses a one-hour default when DTEND is absent and ignores cancelled/all-day events', async () => {
    const ics = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:cancelled\nDTSTART:20260901T100000Z\nDTEND:20260901T110000Z\nSTATUS:CANCELLED\nEND:VEVENT\nBEGIN:VEVENT\nUID:all-day\nDTSTART;VALUE=DATE:20260902\nSUMMARY:All day\nEND:VEVENT\nBEGIN:VEVENT\nUID:timed\nDTSTART:20260903T100000Z\nSUMMARY:Timed\nEND:VEVENT\nEND:VCALENDAR\n`;
    const result = await extractCalendarInvite(
      [attachment()],
      vi.fn().mockResolvedValue({ stream: streamOf(ics) }),
    );

    expect(result?.start_at).toBe('2026-09-03T10:00:00.000Z');
    expect(result?.end_at).toBe('2026-09-03T11:00:00.000Z');
  });

  test('keeps a valid VEVENT when a separate VEVENT is malformed', async () => {
    const ics = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:broken\nDTSTART:20260901T100000Z\nDTSTART:20260901T110000Z\nEND:VEVENT\nBEGIN:VEVENT\nUID:valid\nDTSTART:20260902T100000Z\nDTEND:20260902T103000Z\nSUMMARY:Valid\nEND:VEVENT\nEND:VCALENDAR\n`;
    const result = await extractCalendarInvite(
      [attachment()],
      vi.fn().mockResolvedValue({ stream: streamOf(ics) }),
    );

    expect(result?.title).toBe('Valid');
    expect(result?.start_at).toBe('2026-09-02T10:00:00.000Z');
  });

  test('chooses the earliest valid event across eligible attachments', async () => {
    const later = LIVE_ICS.replace('20260902T150000Z', '20260904T150000Z').replace(
      '20260902T153000Z',
      '20260904T153000Z',
    );
    const readBlob = vi.fn((url) =>
      Promise.resolve({ stream: streamOf(url.endsWith('first.ics') ? later : LIVE_ICS) }),
    );
    const result = await extractCalendarInvite(
      [
        attachment({ blob_url: 'https://store.private.blob.vercel-storage.com/first.ics' }),
        attachment(),
      ],
      readBlob,
    );

    expect(result?.start_at).toBe('2026-09-02T15:00:00.000Z');
    expect(readBlob).toHaveBeenCalledTimes(2);
  });

  test('skips non-downloadable, oversized, and non-calendar attachments', async () => {
    const readBlob = vi.fn();
    const result = await extractCalendarInvite(
      [
        attachment({ downloadable: false }),
        attachment({ size_bytes: MAX_CALENDAR_ATTACHMENT_BYTES + 1 }),
        attachment({ size_bytes: '1.5' }),
        attachment({ size_bytes: '-1' }),
        attachment({ size_bytes: '01' }),
        attachment({ size_bytes: '9007199254740992' }),
        attachment({ filename: 'notes.txt', content_type: 'text/plain' }),
      ],
      readBlob,
    );

    expect(result).toBeNull();
    expect(readBlob).not.toHaveBeenCalled();
  });

  test('returns null when Blob read, stream, or ICS parsing fails', async () => {
    const readBlob = vi
      .fn()
      .mockRejectedValueOnce(new Error('private blob unavailable'))
      .mockResolvedValueOnce({
        stream: streamOf(new Uint8Array(MAX_CALENDAR_ATTACHMENT_BYTES + 1)),
      })
      .mockResolvedValueOnce({ stream: streamOf('not an ical document') });
    const attachments = [
      attachment({ blob_url: 'https://store.private.blob.vercel-storage.com/one.ics' }),
      attachment({
        blob_url: 'https://store.private.blob.vercel-storage.com/two.ics',
        size_bytes: 1,
      }),
      attachment({
        blob_url: 'https://store.private.blob.vercel-storage.com/three.ics',
        size_bytes: 1,
      }),
    ];

    await expect(extractCalendarInvite(attachments, readBlob)).resolves.toBeNull();
  });
});
