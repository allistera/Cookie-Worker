import { describe, expect, test } from 'vitest';
import {
  DEFAULT_ENRICHMENT_SETTINGS,
  isEnrichmentDue,
  normalizeEnrichmentSettings,
  validateEnrichmentSettings,
} from '../enrichmentSettings.js';

describe('enrichment settings', () => {
  test.each([null, 'settings', []])('rejects non-object settings: %j', (input) => {
    expect(validateEnrichmentSettings(input)).toEqual({
      error: 'enrichmentSettings must be an object',
    });
  });

  test.each([null, 'schedule', []])('rejects non-object schedules: %j', (schedule) => {
    expect(validateEnrichmentSettings({ model: 'gpt-5-nano', schedule })).toEqual({
      error: 'schedule must be an object',
    });
  });

  test.each([
    ['enabled', 'yes', 'schedule.enabled must be a boolean'],
    ['days', null, 'schedule.days must contain supported days'],
    ['days', [], 'schedule.days must contain supported days'],
    ['days', ['holiday'], 'schedule.days must contain supported days'],
    ['intervalHours', 5, 'schedule.intervalHours is not supported'],
    ['timezone', 'UTC', 'schedule.timezone must be Europe/London'],
  ])('rejects invalid schedule %s = %j', (field, value, error) => {
    const input = normalizeEnrichmentSettings();
    input.schedule[field] = value;
    expect(validateEnrichmentSettings(input)).toEqual({ error });
  });

  test.each(['startHour', 'endHour'])('rejects invalid %s boundaries', (field) => {
    for (const value of [-1, 24, 1.5, '9']) {
      const input = normalizeEnrichmentSettings();
      input.schedule[field] = value;
      expect(validateEnrichmentSettings(input)).toEqual({
        error: 'schedule hours must be between 0 and 23, with start before end',
      });
    }
  });

  test('normalizes duplicate days and defaults the omitted timezone', () => {
    const input = normalizeEnrichmentSettings();
    input.schedule.days = ['sun', 'mon', 'sun'];
    delete input.schedule.timezone;
    expect(validateEnrichmentSettings(input)).toEqual({
      value: {
        ...input,
        schedule: { ...input.schedule, days: ['mon', 'sun'], timezone: 'Europe/London' },
      },
    });
  });

  test('repairs invalid persisted fields using the configured fallback model', () => {
    const normalized = normalizeEnrichmentSettings(
      { model: 'unknown', schedule: { days: ['invalid'], startHour: -1, endHour: 24 } },
      'gpt-4.1-nano',
    );
    expect(normalized).toEqual({ ...DEFAULT_ENRICHMENT_SETTINGS, model: 'gpt-4.1-nano' });
    normalized.schedule.days.pop();
    expect(DEFAULT_ENRICHMENT_SETTINGS.schedule.days).toHaveLength(7);
  });

  test('defaults to GPT-5 nano every hour from 09:00 through 19:00 UK time', () => {
    expect(normalizeEnrichmentSettings()).toEqual(DEFAULT_ENRICHMENT_SETTINGS);
    expect(isEnrichmentDue(undefined, new Date('2026-07-06T08:00:00Z'))).toBe(true);
    expect(isEnrichmentDue(undefined, new Date('2026-07-06T18:00:00Z'))).toBe(true);
    expect(isEnrichmentDue(undefined, new Date('2026-07-06T19:00:00Z'))).toBe(false);
    expect(isEnrichmentDue(undefined, new Date('2026-12-07T09:00:00Z'))).toBe(true);
  });

  test('uses selected days, inclusive hours, and interval relative to the start hour', () => {
    const settings = {
      model: 'gpt-4.1-nano',
      schedule: {
        enabled: true,
        days: ['mon'],
        startHour: 8,
        endHour: 18,
        intervalHours: 3,
        timezone: 'Europe/London',
      },
    };
    expect(isEnrichmentDue(settings, new Date('2026-01-05T08:00:00Z'))).toBe(true);
    expect(isEnrichmentDue(settings, new Date('2026-01-05T11:00:00Z'))).toBe(true);
    expect(isEnrichmentDue(settings, new Date('2026-01-05T18:00:00Z'))).toBe(false);
    expect(isEnrichmentDue(settings, new Date('2026-01-06T08:00:00Z'))).toBe(false);
  });

  test('skips a disabled schedule and the repeated UK clock-change hour', () => {
    const oneAm = {
      model: 'gpt-5-nano',
      schedule: {
        enabled: true,
        days: ['sun'],
        startHour: 1,
        endHour: 1,
        intervalHours: 1,
        timezone: 'Europe/London',
      },
    };
    expect(isEnrichmentDue(oneAm, new Date('2026-10-25T00:00:00Z'))).toBe(true);
    expect(isEnrichmentDue(oneAm, new Date('2026-10-25T01:00:00Z'))).toBe(false);
    oneAm.schedule.enabled = false;
    expect(isEnrichmentDue(oneAm, new Date('2026-10-25T00:00:00Z'))).toBe(false);
  });

  test('validates supported models and coherent schedules', () => {
    const input = normalizeEnrichmentSettings();
    expect(validateEnrichmentSettings(input)).toEqual({ value: input });
    expect(validateEnrichmentSettings({ ...input, model: 'unknown' }).error).toMatch(/model/);
    expect(
      validateEnrichmentSettings({
        ...input,
        schedule: { ...input.schedule, startHour: 20, endHour: 9 },
      }).error,
    ).toMatch(/hours/);
  });
});
