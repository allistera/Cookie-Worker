import { describe, expect, test } from 'vitest';
import { DEFAULT_ENRICHMENT_SETTINGS } from '../../../shared/enrichmentSettings.js';
import { getEnrichmentSettings, putEnrichmentSettings } from '../src/enrichmentSettings.js';
import { createMockSql } from './helpers.js';

describe('AI Today enrichment settings handlers', () => {
  test('returns defaults when no settings are stored', async () => {
    const response = await getEnrichmentSettings(
      createMockSql([[{ enrichment_settings: null }]]),
      'u1',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enrichmentSettings: DEFAULT_ENRICHMENT_SETTINGS });
  });

  test('validates and stores a supported configuration', async () => {
    const enrichmentSettings = {
      model: 'gpt-4.1-nano',
      schedule: {
        enabled: true,
        days: ['mon', 'fri'],
        startHour: 8,
        endHour: 17,
        intervalHours: 3,
        timezone: 'Europe/London',
      },
    };
    const sql = createMockSql([[{ enrichment_settings: enrichmentSettings }]]);
    const response = await putEnrichmentSettings(sql, 'u1', { enrichmentSettings });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enrichmentSettings });
    expect(sql.calls[0].values[0]).toEqual({ __json: { enrichmentSettings } });
  });

  test('rejects an unknown model without writing', async () => {
    const sql = createMockSql();
    const response = await putEnrichmentSettings(sql, 'u1', {
      enrichmentSettings: { ...DEFAULT_ENRICHMENT_SETTINGS, model: 'unknown' },
    });
    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });
});
