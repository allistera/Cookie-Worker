import { describe, expect, test } from 'vitest';
import {
  DEFAULT_ENRICHMENT_SETTINGS,
  isEnrichmentDue,
  normalizeEnrichmentSettings,
  validateEnrichmentSettings,
} from '../enrichmentSettings.js';

describe('enrichment settings', () => {
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
