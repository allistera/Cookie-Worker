import { describe, expect, it } from 'vitest';
import { matchTimeLine } from '../src/dailyEventLines.js';

/** @param {ReturnType<typeof matchTimeLine>} value */
function assertMatched(value) {
  if (!value) throw new Error('expected matchTimeLine to return a non-null result');
  return value;
}

describe('matchTimeLine', () => {
  it('matches a start-end-title range', () => {
    expect(matchTimeLine('10:00 - 11:00 - Team sync')).toEqual({ start: '10:00', durationMinutes: 60, title: 'Team sync' });
  });

  it('falls back to a single time with a 30-minute default duration', () => {
    expect(matchTimeLine('9:05 - Standup')).toEqual({ start: '09:05', durationMinutes: 30, title: 'Standup' });
  });

  it('does not let the range pattern swallow the end time into a single-time title', () => {
    expect(assertMatched(matchTimeLine('10:00 - 11:00 - Team sync')).title).toBe('Team sync');
  });

  it('rejects an end time at or before the start time', () => {
    expect(matchTimeLine('11:00 - 10:00 - Team sync')).toBeNull();
    expect(matchTimeLine('10:00 - 10:00 - Team sync')).toBeNull();
  });

  it('rejects out-of-range hours or minutes', () => {
    expect(matchTimeLine('25:00 - Team sync')).toBeNull();
    expect(matchTimeLine('10:75 - Team sync')).toBeNull();
  });

  it('rejects an empty title', () => {
    expect(matchTimeLine('10:00 - 11:00 -    ')).toBeNull();
    expect(matchTimeLine('10:00 -    ')).toBeNull();
  });

  it('returns null for text with no time prefix', () => {
    expect(matchTimeLine('Just a note about the renovation')).toBeNull();
    expect(matchTimeLine('')).toBeNull();
    expect(matchTimeLine(undefined)).toBeNull();
  });

  it('trims surrounding whitespace before matching', () => {
    expect(matchTimeLine('   10:00 - 11:00 - Team sync   ')).toEqual({ start: '10:00', durationMinutes: 60, title: 'Team sync' });
  });
});
