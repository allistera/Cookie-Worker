import { describe, expect, it } from 'vitest';

import { isTaskTimeZone, normalizeTaskLabels, normalizeTaskMetadata } from '../src/taskMetadata.js';

describe('task metadata', () => {
  it('normalizes, de-duplicates, and limits labels', () => {
    expect(normalizeTaskLabels(['@Home', 'home', ' errands '])).toEqual(['home', 'errands']);
    expect(() => normalizeTaskLabels(Array.from({ length: 21 }, (_, i) => `label${i}`))).toThrow(
      'at most 20',
    );
    expect(() => normalizeTaskLabels(['two words'])).toThrow('without spaces');
  });

  it('accepts IANA time zones and rejects invalid ones', () => {
    expect(isTaskTimeZone('Europe/London')).toBe(true);
    expect(isTaskTimeZone('not/a-zone')).toBe(false);
  });

  it('requires a date and valid zone whenever a due time is stored', () => {
    expect(
      normalizeTaskMetadata({
        dueDate: '2026-09-11',
        dueTime: '15:05',
        timeZone: 'Europe/London',
        labels: ['@Home'],
      }),
    ).toEqual({ dueTime: '15:05', timeZone: 'Europe/London', labels: ['home'] });

    expect(() =>
      normalizeTaskMetadata({ dueDate: null, dueTime: '15:05', timeZone: 'Europe/London' }),
    ).toThrow('requires a due date');
    expect(() =>
      normalizeTaskMetadata({
        dueDate: '2026-09-11',
        dueTime: '3pm',
        timeZone: 'Europe/London',
      }),
    ).toThrow('HH:MM');
  });

  it('clears a stray time zone when no due time exists', () => {
    expect(
      normalizeTaskMetadata({
        dueDate: '2026-09-11',
        dueTime: null,
        timeZone: 'Europe/London',
      }),
    ).toEqual({ dueTime: null, timeZone: null, labels: [] });
  });
});
