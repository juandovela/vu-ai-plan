/**
 * Measures the rules against plans a person already configured by hand.
 *
 *   npm run validate:real -w @aivu/core -- path/to/basegroup.json [more.json] [--verbose]
 *
 * The plan is stripped of its logic and dependencies, the rules run on what is
 * left, and the result is compared with what the person did: pairs of options
 * that ended in the same exclusive group, and dependencies.
 *
 * Real plans are customer data. Keep them out of the repository (/private is
 * ignored) and pass the paths here.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { buildRuleSuggestions, snapshotFromBasegroup } from '../src';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const files = args.filter(arg => !arg.startsWith('--'));

if (files.length === 0) {
  console.error('Pass at least one basegroup.json');
  process.exit(1);
}

const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const pct = (part: number, total: number) => (total === 0 ? '  n/a' : `${Math.round((100 * part) / total)}%`.padStart(4));

const total = { humanPairs: 0, predicted: 0, tp: 0, humanNest: 0, predictedNest: 0, nestTp: 0 };

files.forEach(file => {
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  const name = (uid: string) => plan.listItems.find((li: any) => li.uid === uid)?.assetName ?? uid;

  const humanPairs = new Set<string>();
  const groups: { [group: string]: string[] } = {};

  plan.listItems.forEach((li: any) =>
    (li.logic || []).forEach((group: number) => (groups[group] = groups[group] || []).push(li.uid))
  );
  Object.values(groups).forEach(members => {
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) humanPairs.add(pairKey(members[i], members[j]));
  });

  const humanNest = new Set<string>();

  plan.listItems.forEach((li: any) => (li.parent || []).forEach((parent: string) => humanNest.add(`${li.uid}>${parent}`)));

  const stripped = plan.listItems.map((li: any) => ({ ...li, logic: [], parent: [], nested: undefined, disabled: false }));
  const snapshot = snapshotFromBasegroup({ listItems: stripped, assets: plan.assets, layout: plan.layout });
  const ops = buildRuleSuggestions(snapshot.items, { floorLabels: snapshot.floorLabels, elevations: snapshot.elevations });

  const predicted = new Set<string>();

  ops.forEach(op => {
    if (op.kind !== 'logicGroup') return;
    const members = op.listItemUids;

    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) predicted.add(pairKey(members[i], members[j]));
  });

  const predictedNest = new Set(ops.filter(op => op.kind === 'nest').map(op => `${(op as any).childUid}>${(op as any).parentUid}`));

  const tp = [...predicted].filter(pair => humanPairs.has(pair));
  const nestTp = [...predictedNest].filter(edge => humanNest.has(edge));

  total.humanPairs += humanPairs.size;
  total.predicted += predicted.size;
  total.tp += tp.length;
  total.humanNest += humanNest.size;
  total.predictedNest += predictedNest.size;
  total.nestTp += nestTp.length;

  console.log(`${basename(file)}  items=${plan.listItems.length}`);
  console.log(`  pairs  human=${humanPairs.size} predicted=${predicted.size} correct=${tp.length}  precision=${pct(tp.length, predicted.size)} recall=${pct(tp.length, humanPairs.size)}`);
  console.log(`  nest   human=${humanNest.size} predicted=${predictedNest.size} correct=${nestTp.length}  precision=${pct(nestTp.length, predictedNest.size)} recall=${pct(nestTp.length, humanNest.size)}`);

  if (verbose) {
    const show = (label: string, list: string[], separator: string) =>
      list.length > 0 && (console.log(`  ${label}:`), list.slice(0, 30).forEach(entry => console.log('     - ' + entry.split(separator).map(name).join('  <>  '))));

    show('predicted, not done by the person', [...predicted].filter(pair => !humanPairs.has(pair)), '|');
    show('done by the person, not predicted', [...humanPairs].filter(pair => !predicted.has(pair)), '|');
  }
});

if (files.length > 1) {
  console.log(`\nALL  pairs precision=${pct(total.tp, total.predicted)} recall=${pct(total.tp, total.humanPairs)}  |  nest precision=${pct(total.nestTp, total.predictedNest)} recall=${pct(total.nestTp, total.humanNest)}`);
}
