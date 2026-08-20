import { describe, expect, it } from 'vitest';
import { flattenWorkbookCellText } from '../src/univerTableData.js';

describe('flattenWorkbookCellText', () => {
  it('reads cell values in row-major order across sheetOrder', () => {
    const workbook = {
      sheetOrder: ['sheet1'],
      sheets: {
        sheet1: {
          cellData: {
            0: { 0: { v: 'Name' }, 1: { v: 'Role' } },
            1: { 0: { v: 'Ada' }, 1: { v: 'Engineer' } },
          },
        },
      },
    };
    expect(flattenWorkbookCellText(workbook)).toEqual(['Name', 'Role', 'Ada', 'Engineer']);
  });

  it('skips empty cells and tolerates a missing workbook', () => {
    const workbook = {
      sheetOrder: ['sheet1'],
      sheets: { sheet1: { cellData: { 0: { 0: { v: '' }, 1: { v: 'Only this' } } } } },
    };
    expect(flattenWorkbookCellText(workbook)).toEqual(['Only this']);
    expect(flattenWorkbookCellText(null)).toEqual([]);
  });
});
