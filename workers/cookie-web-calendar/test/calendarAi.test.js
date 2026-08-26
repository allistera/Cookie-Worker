import { describe, expect, it, vi } from 'vitest';

// Ported from Cookie-Web's api/__tests__/calendar-ai.test.js. The model
// override comes from the env argument instead of process.env, and the
// interpret path is exercised through interpretEvent's overrides seam.
import { generateCalendarEventDraft, normalizeCalendarEventDraft } from '../src/calendarAi.js';
import { interpretEvent } from '../src/calendarEvents.js';

const allowRequest = vi.fn();
vi.mock('../../../shared/rate-limit.js', () => ({
  allowRequest: (...args) => allowRequest(...args),
}));

const USER_ID = '99999999-9999-9999-9999-999999999999';

describe('calendar event AI parsing', () => {
  it('requests strict structured output and normalizes optional fields', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          title: 'Dinner with Sam',
          description: '',
          location: '',
          date: '2026-08-24',
          start: '19:00',
          duration: 120,
          repeat: 'none',
          repeatUntil: '',
          repeatDays: [],
        }),
      }),
    }));

    const result = await generateCalendarEventDraft(
      {
        text: 'Dinner with Sam tomorrow at 7pm for two hours',
        now: '2026-08-23T12:00:00.000Z',
        timeZone: 'Europe/London',
      },
      'test-key',
      /** @type {any} */ (fetchImpl),
      { OPENAI_CALENDAR_MODEL: 'test-calendar-model' },
    );

    expect(result).toEqual({
      model: 'test-calendar-model',
      draft: {
        title: 'Dinner with Sam',
        description: null,
        location: null,
        date: '2026-08-24',
        start: '19:00',
        duration: 120,
        repeat: 'none',
        repeatUntil: null,
        repeatDays: null,
      },
    });
    const request = JSON.parse(/** @type {any} */ (fetchImpl).mock.calls[0][1].body);
    expect(request.model).toBe('test-calendar-model');
    expect(request.text.format).toMatchObject({
      type: 'json_schema',
      name: 'calendar_event',
      strict: true,
    });
    expect(request.input[1].content).toContain('Europe/London');
  });

  it('rejects impossible dates and times from the model', () => {
    expect(() =>
      normalizeCalendarEventDraft({
        title: 'Bad event',
        date: '2026-02-30',
        start: '25:00',
        duration: 30,
        repeat: 'none',
        repeatDays: [],
      }),
    ).toThrow('invalid calendar event');
  });

  it('validates text before claiming quota', async () => {
    allowRequest.mockClear();
    const generator = vi.fn();
    /** @type {any} */
    const sql = vi.fn();

    const response = await interpretEvent(
      sql,
      USER_ID,
      { action: 'interpret', text: '   ', timeZone: 'Europe/London' },
      { OPENAI_API_KEY: 'test-key' },
      { generator },
    );

    expect(response.status).toBe(400);
    expect(allowRequest).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
  });

  it('returns an authenticated, rate-limited AI event draft', async () => {
    const draft = {
      title: 'Dinner with Sam',
      date: '2026-08-24',
      start: '19:00',
      duration: 120,
      repeat: 'none',
    };
    allowRequest.mockClear();
    allowRequest.mockResolvedValue(true);
    const generator = vi.fn(async () => ({ draft, model: 'test-model' }));
    /** @type {any} */
    const sql = vi.fn();

    const response = await interpretEvent(
      sql,
      USER_ID,
      {
        action: 'interpret',
        text: 'Dinner with Sam tomorrow at 7pm for two hours',
        timeZone: 'Europe/London',
      },
      { OPENAI_API_KEY: 'test-key' },
      { generator, now: () => new Date('2026-08-23T12:00:00.000Z') },
    );

    expect(allowRequest).toHaveBeenCalledWith(sql, USER_ID, 'ai', {
      limit: 10,
      windowMs: 60_000,
    });
    expect(generator).toHaveBeenCalledWith(
      {
        text: 'Dinner with Sam tomorrow at 7pm for two hours',
        now: '2026-08-23T12:00:00.000Z',
        timeZone: 'Europe/London',
      },
      'test-key',
      expect.anything(),
      expect.anything(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ draft, model: 'test-model' });
  });
});
