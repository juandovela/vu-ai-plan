import { describe, expect, it } from 'vitest';

import { buildRuleSuggestions, mergeLabels, type Operation } from '../src';
import { item, names, uidOf, woodberry } from './helpers';

const noContext = { floorLabels: {}, elevations: [] };

const groups = (ops: Operation[], snapshot = woodberry()) =>
  ops
    .filter(op => op.kind === 'logicGroup')
    .map(op => names(snapshot, (op as { listItemUids: string[] }).listItemUids).sort());

describe('rules on the Woodberry plan (no sheet)', () => {
  const snapshot = woodberry();
  const ops = buildRuleSuggestions(snapshot.items, { floorLabels: snapshot.floorLabels, elevations: snapshot.elevations });

  it('finds the exclusive groups a person made by hand', () => {
    const found = groups(ops);

    expect(found).toContainEqual(['Optional Elevation D at Floor 1', 'Optional Elevation E at Floor 1']);
    expect(found).toContainEqual(['Optional Elevation D at Floor 2', 'Optional Elevation E at Floor 2']);
    expect(found).toContainEqual([
      'Optional Separate Tub and Shower with Low Wall at Primary Bath',
      'Optional Shower in lieu Tub at Primary Bath'
    ]);
    expect(found).toContainEqual(['Optional Bedroom 5 with Bath 3 at Den and Powder', 'Optional Door at Den']);
  });

  it('does not make upper and lower cabinets exclusive', () => {
    const cabinets = groups(ops).filter(group => group.some(name => /Cabinets/.test(name)));

    expect(cabinets).toEqual([]);
  });

  it('nests the shower under the bedroom that creates Bath 3', () => {
    const nest = ops.find(op => op.kind === 'nest');

    expect(nest).toMatchObject({
      childUid: uidOf(snapshot, 'Optional Shower in lieu Tub at Bath 3'),
      parentUid: uidOf(snapshot, 'Optional Bedroom 5 with Bath 3 at Den and Powder'),
      confidence: 'high'
    });
  });

  it('links each elevation to its options of both floors', () => {
    const packages = ops.filter(op => op.kind === 'elevationPackage') as Array<{ elevationUid: string; listItemUids: string[] }>;

    expect(packages).toHaveLength(2);
    expect(names(snapshot, packages.find(p => p.elevationUid === 'elevation-d')!.listItemUids).sort()).toEqual([
      'Optional Elevation D at Floor 1',
      'Optional Elevation D at Floor 2'
    ]);
  });

  it('only marks as high what is safe to apply without looking', () => {
    ops.filter(op => op.kind === 'filter').forEach(op => expect(op.confidence).toBe('medium'));
  });

  it('gives every operation a stable, unique id', () => {
    const ids = ops.map(op => op.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(buildRuleSuggestions(snapshot.items, { floorLabels: snapshot.floorLabels, elevations: snapshot.elevations }).map(op => op.id)).toEqual(ids);
  });
});

describe('rules on names only (single svg plans)', () => {
  const kitchen = [
    item({ uid: 'k', name: 'Culinary Kitchen' }),
    item({ uid: 'kd', kind: 'structure', name: 'Def. Culinary Kitchen' })
  ];

  it('pairs an option with its default version', () => {
    const ops = buildRuleSuggestions(kitchen, noContext);

    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'logicGroup', listItemUids: ['k', 'kd'], confidence: 'high' });
  });

  it('shares one default between alternatives that have none of their own', () => {
    const items = [
      item({ uid: 'dbl', name: 'Double Doors at Den' }),
      item({ uid: 'fr', name: 'French Doors at Den' }),
      item({ uid: 'def', kind: 'structure', name: 'Def. Double Doors at Den' })
    ];
    const pairs = buildRuleSuggestions(items, noContext)
      .filter(op => op.kind === 'logicGroup')
      .map(op => (op as { listItemUids: string[] }).listItemUids.slice().sort().join('+'));

    expect(pairs).toEqual(expect.arrayContaining(['dbl+def', 'def+fr', 'dbl+fr']));
  });

  it('does not cross defaults when every alternative has its own', () => {
    const items = [
      item({ uid: 'c', name: 'Center Sliding Glass Door at Gathering Room' }),
      item({ uid: 'o', name: 'Open Corner Sliding Glass Door at Gathering Room' }),
      item({ uid: 'cd', kind: 'structure', name: 'Def. Center Sliding Glass Door at Gathering Room' }),
      item({ uid: 'od', kind: 'structure', name: 'Def. Open Corner Sliding Glass Door at Gathering Room' })
    ];
    const pairs = buildRuleSuggestions(items, noContext)
      .filter(op => op.kind === 'logicGroup')
      .map(op => (op as { listItemUids: string[] }).listItemUids.slice().sort().join('+'));

    expect(pairs).toEqual(expect.arrayContaining(['c+cd', 'o+od', 'c+o']));
    expect(pairs).not.toContain('cd+o');
    expect(pairs).not.toContain('c+od');
  });

  it('keeps numbered siblings independent', () => {
    const items = [1, 2, 3].map(n => item({ uid: `s${n}`, name: `Stair Rail - Location ${n}` }));

    expect(buildRuleSuggestions(items, noContext)).toEqual([]);
  });

  it('never takes one bath for another', () => {
    const items = [
      item({ uid: 'a', name: 'Shower at Bath 2' }),
      item({ uid: 'b', kind: 'structure', name: 'Def. Shower at Bath 3' })
    ];

    expect(buildRuleSuggestions(items, noContext)).toEqual([]);
  });

  it('nests a shower under the option that adds its bath', () => {
    const items = [
      item({ uid: 'bed', name: 'Bedroom 6 & Bath 4' }),
      item({ uid: 'sh', name: 'Shower at Bath 4' })
    ];

    expect(buildRuleSuggestions(items, noContext)).toContainEqual(
      expect.objectContaining({ kind: 'nest', childUid: 'sh', parentUid: 'bed' })
    );
  });
});

describe('a drawing that covers the whole floor', () => {
  const whole = { x: 0, y: 0, w: 300, h: 400 };
  const items = [
    item({ uid: 'big', name: 'Optional Enlarged Bedrooms at Floor 1', rect: whole }),
    item({ uid: 'w1', name: 'Optional Window at Bedroom 2', rect: { x: 10, y: 10, w: 3, h: 20 } }),
    item({ uid: 'w2', name: 'Optional Window at Bath 2', rect: { x: 10, y: 100, w: 3, h: 13 } }),
    item({ uid: 'a', name: 'Optional Elevation D at Floor 1', rect: { x: 0, y: 330, w: 300, h: 100 } }),
    item({ uid: 'b', name: 'Optional Elevation E at Floor 1', rect: { x: 0, y: 330, w: 300, h: 100 } })
  ];
  const ops = buildRuleSuggestions(items, noContext).filter(op => op.kind === 'logicGroup') as Array<{
    listItemUids: string[];
    confidence: string;
  }>;

  it('does not chain everything inside it into one group', () => {
    expect(ops.every(op => op.listItemUids.length === 2)).toBe(true);
  });

  it('offers what lies inside it one by one, as a doubt', () => {
    const inside = ops.filter(op => op.listItemUids.includes('big'));

    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every(op => op.confidence === 'low')).toBe(true);
  });

  it('keeps the drawings of similar size together with confidence', () => {
    expect(ops.find(op => op.listItemUids.includes('a') && op.listItemUids.includes('b'))).toMatchObject({ confidence: 'high' });
  });
});

describe('labels', () => {
  const label = (name: string, x: number, y: number, width: number, fontSize = 4) => ({ name, x, y, width, fontSize });

  it('joins the lines of a label in reading order', () => {
    const merged = mergeLabels([
      label('above', 21.25, 94.94, 11),
      label('hood ', 22.18, 90.56, 9),
      label('micro-', 21.15, 86.18, 11),
      label('range w/ ', 18.59, 81.8, 15),
      label('oven / ', 21.18, 77.42, 11),
      label('island', 50.33, 84.86, 10),
      label('Kitchen', 31.45, 114.35, 23, 7)
    ]);

    expect(merged).toContain('oven / range w/ micro-hood above');
    expect(merged).toContain('island');
    expect(merged).toContain('Kitchen');
  });

  it('does not join labels that sit side by side', () => {
    expect(mergeLabels([label('Dining', 95.9, 100.1, 20, 7), label('Living', 173, 100.1, 18, 7)])).toEqual(['Dining', 'Living']);
  });
});
