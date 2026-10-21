import { describe, expect, it } from 'vitest';

import { normalizePlanSheet } from '../src';

describe('normalizePlanSheet', () => {
  it('cleans what the model returns', () => {
    const sheet = normalizePlanSheet({
      planName: '  Plan   2557 ',
      specs: { sqft: '2,557 – 2,584', bedrooms: null, baths: '' },
      elevations: [' Elevation B ', '', 'Elevation D'],
      notes: [{ marker: '**', text: ' Option not available ' }, { marker: '*', text: '' }],
      options: [
        { floorNumber: 1.0, location: ' Den and  Powder ', name: 'Bedroom 5 with Bath 3', caption: '', insetKey: 'f1-b5', replaces: [' Den ', ''], adds: ['Bedroom 5'], marker: '**' },
        { floorNumber: 'two', location: 'Loft', name: 'Bedroom 6', replaces: undefined },
        { floorNumber: 2, location: 'x', name: '   ' }
      ]
    });

    expect(sheet.planName).toBe('Plan 2557');
    expect(sheet.specs).toEqual({ sqft: '2,557 – 2,584', bedrooms: null, baths: null });
    expect(sheet.elevations).toEqual(['Elevation B', 'Elevation D']);
    expect(sheet.notes).toEqual([
      { marker: '**', text: 'Option not available', page: null, kind: 'footnote', appliesTo: [], effect: 'info', target: null }
    ]);
    expect(sheet.options).toHaveLength(2);
    expect(sheet.options[0]).toMatchObject({ floorNumber: 1, location: 'Den and Powder', caption: null, replaces: ['Den'], adds: ['Bedroom 5'], marker: '**' });
    expect(sheet.options[1]).toMatchObject({ floorNumber: null, replaces: [], adds: [], insetKey: null });
  });

  it('survives a reading with almost nothing in it', () => {
    expect(normalizePlanSheet({})).toMatchObject({ planName: null, elevations: [], options: [] });
    expect(normalizePlanSheet({ options: 'not a list', elevations: 5 })).toMatchObject({ elevations: [], options: [] });
  });

  it('refuses something that is not a sheet at all', () => {
    [null, undefined, 'text', 5].forEach(value => expect(() => normalizePlanSheet(value)).toThrow('did not return a plan sheet'));
  });

  it('caps the number of options', () => {
    const options = Array.from({ length: 500 }, (_, i) => ({ location: 'x', name: `Option ${i}` }));

    expect(normalizePlanSheet({ options }).options).toHaveLength(200);
  });

  it('keeps what a note asks for only when it has something to act on', () => {
    const sheet = normalizePlanSheet({
      options: [{ name: 'Door', location: 'Den' }],
      notes: [
        { text: 'Not available on every lot', effect: 'not-available', appliesTo: ['Door at Den'], page: 3.4, kind: 'drawing' },
        { text: 'Not available with Door', effect: 'excludes', appliesTo: ['Fireplace'] },
        { text: 'Needs the den', effect: 'depends-on', appliesTo: ['Door'], target: 'Den' },
        { text: 'Hide it', effect: 'hide', appliesTo: [] },
        { text: 'Odd', effect: 'delete-everything', appliesTo: ['Door'] }
      ]
    });

    expect(sheet.notes.map(note => note.effect)).toEqual(['not-available', 'info', 'depends-on', 'info', 'info']);
    expect(sheet.notes[0]).toMatchObject({ page: 3, kind: 'drawing' });
  });
});
