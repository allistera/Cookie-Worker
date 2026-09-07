import { describe, expect, test } from 'vitest';
import { autoArchiveRules, autoArchiveSettings, updateAutoArchive } from '../autoArchive.js';

const FIRST = '2026-09-07T10:00:00.000Z';
const LATER = '2026-09-08T10:00:00.000Z';
const flags = { marketing: true, coldPitches: false, socialNoise: false };

describe('auto archive preferences', () => {
  test('defaults every category off and fails closed on invalid stored values', () => {
    expect(autoArchiveSettings(null)).toEqual({
      marketing: false,
      coldPitches: false,
      socialNoise: false,
    });
    expect(autoArchiveRules({ marketing: { enabled: true, since: 'invalid' } }, LATER)).toEqual([]);
  });

  test('preserves activation dates on save, but resets them when re-enabled', () => {
    const initial = updateAutoArchive(null, flags, FIRST);
    expect(initial.marketing.since).toBe(FIRST);
    expect(updateAutoArchive(initial, flags, LATER).marketing.since).toBe(FIRST);
    const disabled = updateAutoArchive(initial, { ...flags, marketing: false }, FIRST);
    expect(updateAutoArchive(disabled, flags, LATER).marketing.since).toBe(LATER);
  });

  test.each(['marketing', 'coldPitches', 'socialNoise'])(
    'offers only the enabled %s category for new mail',
    (category) => {
      const saved = updateAutoArchive(
        null,
        { marketing: false, coldPitches: false, socialNoise: false, [category]: true },
        FIRST,
      );
      expect(autoArchiveRules(saved, '2026-09-06T00:00:00Z')).toEqual([]);
      expect(autoArchiveRules(saved, undefined)).toEqual([]);
      expect(autoArchiveRules(saved, LATER)).toMatchObject([
        { id: `auto-archive:${category}`, autoArchiveCategory: category, action: 'mark_done' },
      ]);
    },
  );
});
