import { describe, expect, it } from 'vitest';
import { flattenBlocksToText } from '../src/documentText.js';

describe('flattenBlocksToText', () => {
  it('joins the title with paragraph and header text', () => {
    const blocks = [
      { type: 'header', data: { text: 'Kickoff notes', level: 2 } },
      { type: 'paragraph', data: { text: 'Ship the <b>widget</b> by Friday.' } },
    ];
    expect(flattenBlocksToText('Project Plan', blocks)).toBe(
      'Project Plan\nKickoff notes\nShip the widget by Friday.',
    );
  });

  it('strips inline HTML markup and entities from text', () => {
    const blocks = [{ type: 'paragraph', data: { text: 'Tom &amp; Jerry &lt;3 &nbsp;cats' } }];
    expect(flattenBlocksToText('', blocks)).toBe('Tom & Jerry <3  cats');
  });

  it('walks nested list items at any depth', () => {
    const blocks = [
      {
        type: 'list',
        data: {
          items: [
            { content: 'Buy milk', items: [{ content: 'Whole', items: [{ content: 'Organic' }] }] },
            { content: 'Buy eggs' },
          ],
        },
      },
    ];
    expect(flattenBlocksToText('Groceries', blocks)).toBe(
      'Groceries\nBuy milk\nWhole\nOrganic\nBuy eggs',
    );
  });

  it('flattens table cells row by row', () => {
    const blocks = [
      {
        type: 'table',
        data: {
          content: [
            ['Name', 'Role'],
            ['Ada', 'Engineer'],
          ],
        },
      },
    ];
    expect(flattenBlocksToText('', blocks)).toBe('Name\nRole\nAda\nEngineer');
  });

  it('flattens a Univer workbook snapshot in reading order', () => {
    const blocks = [
      {
        type: 'table',
        data: {
          workbook: {
            sheetOrder: ['sheet1'],
            sheets: {
              sheet1: {
                cellData: {
                  0: { 0: { v: 'Name' }, 1: { v: 'Role' } },
                  1: { 0: { v: 'Ada' }, 1: { v: 'Engineer' } },
                },
              },
            },
          },
        },
      },
    ];
    expect(flattenBlocksToText('', blocks)).toBe('Name\nRole\nAda\nEngineer');
  });

  it('includes code block contents and image captions', () => {
    const blocks = [
      { type: 'code', data: { code: 'const x = 1' } },
      { type: 'image', data: { caption: 'A diagram' } },
    ];
    expect(flattenBlocksToText('', blocks)).toBe('const x = 1\nA diagram');
  });

  it('flattens kanban lane and task text', () => {
    const blocks = [
      {
        type: 'kanban',
        data: {
          lanes: [
            {
              title: 'Todo',
              tasks: [{ title: 'Write docs', description: 'Cover the new block type' }],
            },
            { title: 'Done', tasks: [] },
          ],
        },
      },
    ];
    expect(flattenBlocksToText('Board', blocks)).toBe(
      'Board\nTodo\nWrite docs\nCover the new block type\nDone',
    );
  });

  it('skips blocks with no representable text', () => {
    const blocks = [{ type: 'delimiter' }, { type: 'date', data: { date: '2026-01-01' } }];
    expect(flattenBlocksToText('Just a title', blocks)).toBe('Just a title');
  });

  it('tolerates missing/malformed blocks and returns just the title', () => {
    expect(flattenBlocksToText('Title only', null)).toBe('Title only');
    expect(flattenBlocksToText('', [])).toBe('');
    expect(flattenBlocksToText(undefined, undefined)).toBe('');
  });
});
