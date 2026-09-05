import { describe, expect, it } from 'vitest';
import { parseTaskRecurrence, taskOccurrence } from '../src/taskRecurrence.js';

describe('task recurrence', () => {
  it.each([
    [' EVERY   Monday ', 'every monday'],
    ['every 2nd Tuesday', 'every 2nd tuesday'],
    ['every 2nd Tuesday of each month', 'every 2nd tuesday'],
    ['every 3 days', 'every 3 days'],
    ['daily', 'every day'],
    ['weekly', 'every week'],
  ])('normalizes %s', (input, expected) => {
    expect(parseTaskRecurrence(input)?.text).toBe(expected);
  });
  it.each([
    'every 0 days',
    'every -2 days',
    'every 366 days',
    'every 2th Tuesday',
    'every Monday of month',
    'every 3 days at noon',
    'every nonsense',
    {},
    3,
  ])('rejects %s', (input) => {
    expect(parseTaskRecurrence(input)).toBeNull();
  });
  it.each([
    ['every Monday', '2026-09-05', null, '2026-09-07'],
    ['every Monday', '2026-09-07', null, '2026-09-07'],
    ['every Monday', '2026-09-07', '2026-09-07', '2026-09-14'],
    ['every Monday', '2026-09-07', '2026-09-30', '2026-10-05'],
    ['every 2nd Tuesday', '2026-09-05', null, '2026-09-08'],
    ['every 2nd Tuesday', '2026-09-08', '2026-09-08', '2026-10-13'],
    ['every 2nd Tuesday', '2026-12-08', '2026-12-08', '2027-01-12'],
    ['every 5th Monday', '2026-02-01', null, '2026-03-30'],
    ['every last Friday', '2028-02-01', null, '2028-02-25'],
    ['every 3 days', '2026-09-05', null, '2026-09-05'],
    ['every 3 days', '2026-09-05', '2026-09-05', '2026-09-08'],
    ['every 3 days', '2026-09-05', '2026-09-12', '2026-09-14'],
    ['every 3 days', '2026-09-05', '2026-09-01', '2026-09-08'],
    ['every 2 weeks', '2026-09-05', '2026-09-05', '2026-09-19'],
    ['every day', '2028-02-28', '2028-02-28', '2028-02-29'],
    ['every day', '2026-03-08', '2026-03-08', '2026-03-09'],
  ])('%s from %s after %s gives %s', (rule, start, after, expected) => {
    expect(taskOccurrence(rule, start, after)).toBe(expected);
  });
});
