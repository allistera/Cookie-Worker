import { describe, expect, it } from 'vitest';
import { parseDailyNoteDate } from '../src/documentDates.js';

describe('parseDailyNoteDate', () => {
  it('parses DD-MM-YY into the matching date', () => {
    expect(parseDailyNoteDate('13-08-26')).toEqual(new Date(2026, 7, 13));
    expect(parseDailyNoteDate('01-01-26')).toEqual(new Date(2026, 0, 1));
  });

  it('rejects titles that are not exactly that shape', () => {
    expect(parseDailyNoteDate('Project Plan')).toBeNull();
    expect(parseDailyNoteDate('13-8-26')).toBeNull();
    expect(parseDailyNoteDate('2026-08-13')).toBeNull();
    expect(parseDailyNoteDate('')).toBeNull();
    expect(parseDailyNoteDate(undefined)).toBeNull();
  });

  it('rejects a title shaped like a date that does not exist', () => {
    expect(parseDailyNoteDate('31-02-26')).toBeNull();
    expect(parseDailyNoteDate('00-01-26')).toBeNull();
  });
});
