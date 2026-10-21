import { expect, test } from 'vitest';
import { plainText } from '../src/plainText.js';
import { flattenBlocksToText } from '../src/documentText.js';
import { parseTimeLine } from '../src/dailyEventSync.js';

test('decodes escaped entities once in search and daily-note titles', () => {
  expect(plainText('<b>&amp;lt; &lt; &amp;gt;</b>')).toBe('&lt; < &gt;');
  expect(flattenBlocksToText('', [{ type: 'paragraph', data: { text: '&amp;lt;' } }])).toBe('&lt;');
  expect(parseTimeLine('10:00 - 11:00 - &amp;lt;')).toMatchObject({ title: '&lt;' });
});
