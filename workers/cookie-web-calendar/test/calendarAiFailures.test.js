import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { interpretEvent } from '../src/calendarEvents.js';
import { normalizeCalendarEventDraft } from '../src/calendarAi.js';

const draft = { title: 'Review', date: '2026-10-21', start: '09:00', duration: 30, repeat: 'none' };
const body = { text: '  Review tomorrow  ', timeZone: 'UTC' };
const env = { OPENAI_API_KEY: 'test-key' };
function database() {
  /** @type {any} */
  const sql = vi.fn().mockResolvedValue([{ allowed: true }]);
  return sql;
}
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('calendar AI request failures', () => {
  test.each([
    { text: 'x'.repeat(1001), timeZone: 'UTC' },
    { text: 'Review', timeZone: 'Invalid/Zone' },
    {},
  ])('rejects invalid input %j without quota', async (input) => {
    const sql = database();
    const response = await interpretEvent(sql, 'owner', input, env);
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('rejects unconfigured AI before quota', async () => {
    const sql = database();
    const response = await interpretEvent(sql, 'owner', body, {});
    expect(response.status).toBe(503);
    expect(sql).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'fails closed when quota is denied or unavailable (%s)',
    async (unavailable) => {
      const sql = database();
      if (unavailable) sql.mockRejectedValue(new Error('database unavailable'));
      else sql.mockResolvedValue([{ allowed: false }]);
      const generator = vi.fn();
      const response = await interpretEvent(sql, 'owner', body, env, { generator });
      expect(response.status).toBe(unavailable ? 503 : 429);
      expect(generator).not.toHaveBeenCalled();
    },
  );

  test('maps upstream HTTP failure to a calendar AI error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unavailable', { status: 503 })));
    const response = await interpretEvent(database(), 'owner', body, env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'AI calendar creation failed' });
  });

  test.each([undefined, 'compose-model'])(
    'uses the default generator and model fallback %s',
    async (composeModel) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
      const fetchMock = vi
        .fn()
        .mockResolvedValue(Response.json({ output_text: JSON.stringify(draft) }));
      vi.stubGlobal('fetch', fetchMock);
      const response = await interpretEvent(database(), 'owner', body, {
        ...env,
        OPENAI_COMPOSE_MODEL: composeModel,
      });
      expect(response.status).toBe(200);
      const request = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(request.model).toBe(composeModel || 'gpt-5.6-luna');
      expect(JSON.parse(request.input[1].content)).toEqual({
        request: 'Review tomorrow',
        current_datetime: '2026-10-20T12:00:00.000Z',
        time_zone: 'UTC',
      });
    },
  );
});

describe('calendar AI output validation', () => {
  test.each([
    { title: '' },
    { start: '25:00' },
    { duration: 1.5 },
    { duration: 0 },
    { duration: 43201 },
    { repeat: 'hourly' },
    { repeatUntil: 'not a date' },
    { repeatDays: ['XX'] },
  ])('rejects invalid model fields %j', (patch) => {
    expect(() => normalizeCalendarEventDraft({ ...draft, ...patch })).toThrow(
      'invalid calendar event',
    );
  });

  test('bounds optional strings and deduplicates weekly recurrence days', () => {
    expect(
      normalizeCalendarEventDraft({
        ...draft,
        title: 'x'.repeat(201),
        description: 'd'.repeat(2001),
        location: 'l'.repeat(201),
        repeat: 'weekly',
        repeatDays: ['MO', 'MO', 'FR'],
        repeatUntil: '2026-12-31',
      }),
    ).toEqual({
      ...draft,
      title: 'x'.repeat(200),
      description: 'd'.repeat(2000),
      location: 'l'.repeat(200),
      repeat: 'weekly',
      repeatDays: ['MO', 'FR'],
      repeatUntil: '2026-12-31',
    });
  });
});
