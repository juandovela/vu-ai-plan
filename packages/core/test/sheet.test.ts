import { describe, expect, it } from 'vitest';

import { analyzeDeterministic, buildSheetSuggestions, type Operation, type PlanSheet } from '../src';
import { item, names, uidOf, woodberry, woodberrySheet } from './helpers';

const renames = (ops: Operation[]) =>
  ops.filter(op => op.kind === 'rename').map(op => `${(op as { from: string }).from} => ${(op as { to: string }).to}`);

describe('plan sheet (PDF) against the Woodberry plan', () => {
  const snapshot = woodberry();
  const { ops, findings } = buildSheetSuggestions(snapshot.items, snapshot.floors, woodberrySheet());

  it('matches the 15 options of the sheet with the 15 layers', () => {
    expect(findings.filter(finding => finding.severity === 'warning')).toEqual([]);
  });

  it('catches the patio placed in the wrong room', () => {
    expect(renames(ops)).toContain('Optional Covered Patio at Great Room => Optional Covered Patio at Dining');
  });

  it('fixes the wording of the sheet', () => {
    const found = renames(ops);

    expect(found).toContain('Optional Shower in lieu Tub at Bath 3 => Optional Shower in lieu of Tub at Bath 3');
    expect(found).toContain('Optional Shower in lieu Tub at Bath 2 => Optional Shower in lieu of Tub at Bath 2');
    expect(found).toContain('Optional Shower in lieu Tub at Primary Bath => Optional Shower in lieu of Tub at Primary Bath');
    expect(found).toContain(
      'Optional Separate Tub and Shower with Low Wall at Primary Bath => Optional Separate Tub and Shower at Primary Bath'
    );
    expect(found).toHaveLength(5);
  });

  it('keeps the builder prefix and never proposes a change it is unsure about as high', () => {
    ops.filter(op => op.kind === 'rename').forEach(op => {
      expect((op as { to: string }).to.startsWith('Optional ')).toBe(true);
      expect(op.confidence).toBe('medium');
    });
  });

  it('excludes what is located in a room the sheet says is replaced', () => {
    const group = ops.find(op => op.kind === 'logicGroup') as { listItemUids: string[]; source: string; confidence: string };

    expect(names(snapshot, group.listItemUids).sort()).toEqual([
      'Optional Bedroom 5 with Bath 3 at Den and Powder',
      'Optional Door at Den'
    ]);
    expect(group).toMatchObject({ source: 'pdf', confidence: 'high' });
  });

  it('nests what is located in a room the sheet says is created', () => {
    expect(ops).toContainEqual(
      expect.objectContaining({
        kind: 'nest',
        childUid: uidOf(snapshot, 'Optional Shower in lieu Tub at Bath 3'),
        parentUid: uidOf(snapshot, 'Optional Bedroom 5 with Bath 3 at Den and Powder'),
        source: 'pdf'
      })
    );
  });

  it('points out options drawn together and the standard elevation, without proposing changes', () => {
    const info = findings.filter(finding => finding.severity === 'info').map(finding => finding.message);

    expect(info.some(message => message.includes('Upper and Lower Cabinets at Kitchen and Dining'))).toBe(true);
    expect(info.some(message => message.includes('Upper and Lower Cabinets at Laundry'))).toBe(true);
    expect(info.some(message => message.includes('Elevation B has no option layers'))).toBe(true);
    expect(renames(ops).some(rename => rename.includes('Cabinets'))).toBe(false);
  });

  it('suggests nothing when the sheet is from another plan', () => {
    const unrelated = ['Fireplace', 'Wet Bar', 'Sauna', 'Swimming Pool', 'Cabana', 'Wine Cellar', 'Home Theater', 'Gym', 'Library', 'Studio', 'Greenhouse', 'Workshop', 'Mudroom', 'Pantry Expansion', 'Sunroom'];
    const other: PlanSheet = {
      ...woodberrySheet(),
      planName: 'Plan 1234',
      options: woodberrySheet().options.map((option, index) => ({ ...option, name: unrelated[index], location: 'Garage' }))
    };
    const result = buildSheetSuggestions(snapshot.items, snapshot.floors, other);

    expect(result.ops).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].message).toContain('Is it the right PDF');
    expect(result.findings[0].message).toContain('Plan 1234');
  });

  it('marks what the sheet says is not available everywhere', () => {
    const sheet = woodberrySheet();
    sheet.options.find(option => option.name === 'Island')!.marker = '**';

    const result = buildSheetSuggestions(snapshot.items, snapshot.floors, sheet);

    expect(result.ops).toContainEqual(
      expect.objectContaining({ kind: 'filter', filter: 'not-available', listItemUid: uidOf(snapshot, 'Optional Island at Kitchen') })
    );
  });

  it('reports what the sheet lists and the plan lacks, and the reverse', () => {
    const extra: PlanSheet = { ...woodberrySheet(), options: [...woodberrySheet().options, { ...woodberrySheet().options[0], name: 'Fireplace', location: 'Living', floorNumber: 1 }] };
    const lacking = buildSheetSuggestions(snapshot.items, snapshot.floors, extra).findings.map(finding => finding.message);

    expect(lacking.some(message => message.includes('lists "Fireplace at Living"'))).toBe(true);

    const withExtraLayer = [...snapshot.items, item({ uid: 'x', name: 'Optional Sauna at Garage', floorUid: 'floor-1' })];
    const unlisted = buildSheetSuggestions(withExtraLayer, snapshot.floors, woodberrySheet()).findings.map(finding => finding.message);

    expect(unlisted).toContain('"Optional Sauna at Garage" is not in the sheet\'s options.');
  });
});

describe('analyzeDeterministic', () => {
  it('lets the sheet win over a rename guessed from the layer name and over the same finding of the rules', () => {
    const snapshot = woodberry();
    const target = snapshot.items.find(candidate => candidate.name === 'Optional Shower in lieu Tub at Bath 3')!;

    target.originalName = 'Optional Shower in lieu Tub at Bath 3.';

    const { operations } = analyzeDeterministic({ ...snapshot, sheet: woodberrySheet() });
    const renamed = operations.filter(op => op.kind === 'rename' && op.listItemUid === target.uid);

    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({ source: 'pdf', to: 'Optional Shower in lieu of Tub at Bath 3' });

    const nest = operations.filter(op => op.kind === 'nest');

    expect(nest).toHaveLength(1);
    expect(nest[0].source).toBe('pdf');
  });

  it('works without a sheet', () => {
    const { operations, findings } = analyzeDeterministic(woodberry());

    expect(operations.length).toBeGreaterThan(5);
    expect(findings).toEqual([]);
    expect(operations.every(op => op.source === 'rules')).toBe(true);
  });
});

describe('what the sheet already got applied is not proposed again', () => {
  it('does not offer the exclusive group of a replaced room twice', () => {
    const snapshot = woodberry();
    const first = buildSheetSuggestions(snapshot.items, snapshot.floors, woodberrySheet()).ops;
    const group = first.find(op => op.kind === 'logicGroup') as { listItemUids: string[] };

    expect(group).toBeDefined();

    // the person applied it: both options are now in group 7
    const applied = snapshot.items.map(entry => (group.listItemUids.includes(entry.uid) ? { ...entry, logic: [7] } : entry));
    const again = buildSheetSuggestions(applied, snapshot.floors, woodberrySheet()).ops;

    expect(again.filter(op => op.kind === 'logicGroup')).toEqual([]);
  });
});

describe('the notes of the sheet', () => {
  const snapshot = woodberry();
  const withNotes = (notes: Array<Record<string, unknown>>) => {
    const sheet = woodberrySheet();

    sheet.notes = notes.map(note => ({
      marker: '',
      page: 3,
      kind: 'drawing' as const,
      appliesTo: [],
      effect: 'info' as const,
      target: null,
      text: 'x',
      ...note
    })) as typeof sheet.notes;

    return buildSheetSuggestions(snapshot.items, snapshot.floors, sheet);
  };
  const filters = (ops: Operation[]) => ops.filter(op => op.kind === 'filter').map(op => (op as { listItemUid: string; filter: string }));

  it('turns "not available" into the filter, for the option it names', () => {
    const { ops } = withNotes([{ text: 'Not available on every lot', effect: 'not-available', appliesTo: ['Door at Den'] }]);
    const found = filters(ops).filter(op => op.filter === 'not-available');

    expect(found.map(op => op.listItemUid)).toContain(uidOf(snapshot, 'Optional Door at Den'));
    expect(ops.find(op => op.kind === 'filter' && op.reason.includes('Page 3'))).toMatchObject({ source: 'pdf', confidence: 'medium' });
  });

  it('proposes an exclusive group for "excludes" and a nest for "depends-on"', () => {
    const { ops } = withNotes([
      { text: 'Not available with Door at Den', effect: 'excludes', appliesTo: ['Covered Patio at Dining'], target: 'Door at Den' },
      {
        text: 'Needs Bedroom 5',
        effect: 'depends-on',
        appliesTo: ['Island at Kitchen'],
        target: 'Bedroom 5 with Bath 3 at Den and Powder'
      }
    ]);
    const group = ops.filter(op => op.kind === 'logicGroup').find(op => op.reason.startsWith('Note on the sheet'));
    const nest = ops.find(op => op.kind === 'nest' && op.reason.startsWith('Note on the sheet'));

    expect(group).toBeDefined();
    expect(nest).toMatchObject({ parentUid: uidOf(snapshot, 'Optional Bedroom 5 with Bath 3 at Den and Powder') });
  });

  it('shows a note it can not act on, with what it is about, instead of losing it', () => {
    const { ops, findings } = withNotes([
      { text: 'opt. fireplace', effect: 'info', appliesTo: ['Fireplace at Family'] },
      { text: 'transom window at 9 plate option', effect: 'info', appliesTo: ['Transom Window'] },
      { text: 'Not available on every lot', effect: 'not-available', appliesTo: ['Hovercraft Dock'] }
    ]);
    const notes = findings.filter(finding => finding.id.startsWith('note:'));

    expect(notes.map(note => note.message).join('\n')).toContain('"transom window at 9 plate option"');
    expect(notes.some(note => note.severity === 'warning' && note.message.includes('Hovercraft Dock'))).toBe(true);
    expect(filters(ops).some(op => op.filter === 'not-available' && op.listItemUid === undefined)).toBe(false);
  });

  it('does not propose twice what the marker already did', () => {
    const { ops } = withNotes([{ text: 'x', effect: 'not-available', appliesTo: ['Door at Den'] }, { text: 'y', effect: 'not-available', appliesTo: ['Door at Den'] }]);
    const ids = ops.map(op => op.id);

    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe('what a real sheet taught (Willow Landing)', () => {
  const floors = [{ uid: 'floor-2', floorNumber: 2 }];
  const base = { floorUid: 'floor-2', floor: 'Floor 2' };
  const sheetOf = (options: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    ({ planName: null, specs: { sqft: null, bedrooms: null, baths: null }, elevations: [], notes: [], options: options.map(o => ({ floorNumber: 2, caption: null, insetKey: null, replaces: [], adds: [], marker: null, ...o })), ...extra }) as unknown as PlanSheet;

  it('reads elevation captions printed with quotes', () => {
    const items = [item({ uid: 'e', name: 'Optional Elevation B at Floor 2', ...base })];
    const { findings } = buildSheetSuggestions(items, floors, sheetOf([{ name: 'Door', location: 'Den' }], { elevations: ["Elevation 'A'", "Elevation 'B'"] }));

    expect(findings.some(f => f.id.startsWith('elevation:'))).toBe(false);
  });

  it('does not take a table heading for a place, nor add a place the name already has', () => {
    const items = [
      item({ uid: 'a', name: 'Optional Enlarged Bedrooms 2 and 3 with Bath 5 at Floor 2', ...base }),
      item({ uid: 'b', name: 'Optional Double Doors at Den', ...base })
    ];
    const { ops } = buildSheetSuggestions(
      items,
      floors,
      sheetOf([
        { name: 'Enlarged Bedrooms 2 and 3 with Bath 2', location: 'Floor Options' },
        { name: 'Double Doors at Den', location: 'Living' }
      ])
    );
    const renames = ops.filter(op => op.kind === 'rename').map(op => (op as { to: string }).to);

    expect(renames).toEqual(['Optional Enlarged Bedrooms 2 and 3 with Bath 2 at Floor 2']);
  });

  it('leaves a layer that places the option more precisely than the sheet', () => {
    const items = [item({ uid: 'r', name: 'Optional Open Rail at Floor 1 Stairs', ...base })];
    const { ops } = buildSheetSuggestions(items, floors, sheetOf([{ name: 'Open Rail', location: 'Stairs' }]));

    expect(ops.filter(op => op.kind === 'rename')).toEqual([]);
  });

  it('excludes, not nests, what is located in a room the floor already has', () => {
    const items = [
      item({ uid: 'big', name: 'Optional Enlarged Bedrooms with Bath 2 at Floor 2', ...base }),
      item({ uid: 'sinks', name: 'Optional Dual Sinks at Bath 2', ...base })
    ];
    const sheet = sheetOf([{ name: 'Enlarged Bedrooms with Bath 2', location: 'Floor 2', adds: ['Bath 2'] }, { name: 'Dual Sinks', location: 'Bath 2' }]);
    const exists = buildSheetSuggestions(items, floors, sheet, { 'floor-2': ['bath2'] }).ops;
    const created = buildSheetSuggestions(items, floors, sheet, { 'floor-2': [] }).ops;

    expect(exists.some(op => op.kind === 'logicGroup')).toBe(true);
    expect(exists.some(op => op.kind === 'nest')).toBe(false);
    expect(created.some(op => op.kind === 'nest')).toBe(true);
  });

  it('finds the option an annotation names by the sheet\'s own name', () => {
    const items = [item({ uid: 'f', name: 'Optional Fireplace at Family', ...base })];
    const { findings } = buildSheetSuggestions(
      items,
      floors,
      sheetOf([{ name: 'Fireplace', location: 'Great Room' }], {
        notes: [{ marker: '', text: 'opt. fireplace', page: 3, kind: 'drawing', appliesTo: ['Fireplace'], effect: 'info', target: null }]
      })
    );

    expect(findings.find(f => f.id === 'note:0')?.message).toContain('Optional Fireplace at Family');
  });

  it('does not show plan labels that say nothing about an option, and says when a name is ambiguous', () => {
    const items = [
      item({ uid: 'd1', name: 'Optional Door at Den', ...base, floor: 'Floor 1', floorUid: 'floor-1' }),
      item({ uid: 'd2', name: 'Optional Door at Primary Bath', ...base })
    ];
    const note = (text: string, appliesTo: string[] = []) => ({ marker: '', page: 2, kind: 'drawing', appliesTo, effect: 'info', target: null, text });
    const { findings } = buildSheetSuggestions(
      items,
      [...floors, { uid: 'floor-1', floorNumber: 1 }],
      sheetOf([{ name: 'Door', location: 'Den', floorNumber: 1 }, { name: 'Door', location: 'Primary Bath' }], {
        notes: [note('low wall'), note('d/w'), note('opt. door', ['Door']), note('transom window at 9 plate option')]
      })
    );
    const shown = findings.filter(f => f.id.startsWith('note:')).map(f => f.message);

    expect(shown.some(m => m.includes('low wall') || m.includes('"d/w"'))).toBe(false);
    expect(shown.some(m => m.includes('transom window'))).toBe(true);
    expect(shown.some(m => m.includes('opt. door'))).toBe(true);
  });
});
