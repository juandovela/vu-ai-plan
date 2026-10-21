import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyzeDeterministic, buildSheetSuggestions, normalizePlanSheet, planSheetSchema } from '../src';
import { woodberry, woodberrySheet } from './helpers';

/**
 * What Gemini really answered when it read the Woodberry PDF (copied from the
 * app, nothing edited). Not an expectation of what the model must say, but a
 * realistic input: the suggestions that come out of it must not drift when the
 * rules change.
 */
const real = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'woodberry-2557.gemini-reading.json'), 'utf8'));

describe('a real reading of the Woodberry PDF', () => {
  it('already is what the contract asks for', () => {
    expect(planSheetSchema.safeParse(real).success).toBe(true);
  });

  it('is left alone by the cleaning the server does', () => {
    expect(normalizePlanSheet(real)).toEqual(planSheetSchema.parse(real));
  });

  it('read every option of the sheet, with the rooms it replaces and creates', () => {
    const sheet = normalizePlanSheet(real);

    expect(sheet.options).toHaveLength(15);
    expect(sheet.elevations).toEqual(['Elevation B', 'Elevation D', 'Elevation E']);

    const bedroom5 = sheet.options.find(option => option.name === 'Bedroom 5 with Bath 3')!;

    expect(bedroom5.replaces).toEqual(['Den', 'Powder']);
    expect(bedroom5.adds).toEqual(['Bedroom 5', 'Bath 3']);
    expect(sheet.options.find(option => option.name === 'Bedroom 6')!.replaces).toEqual(['Loft']);
  });

  it('keeps the options drawn together together', () => {
    const sheet = normalizePlanSheet(real);
    const together = (location: string) => sheet.options.filter(option => option.location === location && option.name.endsWith('Cabinets'));

    ['Kitchen and Dining', 'Laundry'].forEach(location => {
      const pair = together(location);

      expect(pair).toHaveLength(2);
      expect(pair[0].insetKey).toBe(pair[1].insetKey);
    });

    // and nothing else shares an inset
    const keys = sheet.options.map(option => option.insetKey);

    expect(new Set(keys).size).toBe(keys.length - 2);
  });

  it('gives the same suggestions as the hand made reference', () => {
    const snapshot = woodberry();
    const fromReal = buildSheetSuggestions(snapshot.items, snapshot.floors, normalizePlanSheet(real));
    const fromReference = buildSheetSuggestions(snapshot.items, snapshot.floors, woodberrySheet());
    const ids = (ops: typeof fromReal.ops) => ops.map(op => `${op.id}|${op.source}|${op.confidence}`).sort();

    expect(ids(fromReal.ops)).toEqual(ids(fromReference.ops));
    expect(fromReal.findings.map(finding => finding.message).sort()).toEqual(fromReference.findings.map(finding => finding.message).sort());
    expect(fromReal.ops).toHaveLength(7);
  });

  it('flows through the whole analysis', () => {
    const { operations, findings } = analyzeDeterministic({ ...woodberry(), sheet: normalizePlanSheet(real) });

    expect(operations.filter(op => op.source === 'pdf')).toHaveLength(7);
    expect(operations.filter(op => op.kind === 'rename')).toHaveLength(5);
    expect(findings.filter(finding => finding.severity === 'warning')).toEqual([]);
  });
});
