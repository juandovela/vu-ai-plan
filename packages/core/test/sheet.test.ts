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
