import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planSheetSchema, snapshotSchema, type PlanItem, type PlanSheet, type PlanSnapshot } from '../src';

const here = dirname(fileURLToPath(import.meta.url));

const read = (name: string) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

/** Woodberry (plan 2557) right after it was imported: nothing configured. */
export const woodberry = (): PlanSnapshot => snapshotSchema.parse(read('woodberry-2557.snapshot.json'));

/** What a good reading of its PDF looks like. */
export const woodberrySheet = (): PlanSheet => planSheetSchema.parse(read('woodberry-2557.sheet.json'));

export const uidOf = (snapshot: PlanSnapshot, name: string) => {
  const item = snapshot.items.find(candidate => candidate.name === name);

  if (!item) throw new Error(`no item named "${name}"`);

  return item.uid;
};

/** Names of the items an operation points at, for readable assertions. */
export const names = (snapshot: PlanSnapshot, uids: string[]) =>
  uids.map(uid => snapshot.items.find(item => item.uid === uid)?.name ?? uid);

export function item(partial: Partial<PlanItem> & Pick<PlanItem, 'uid' | 'name'>): PlanItem {
  return {
    kind: 'option',
    originalName: null,
    floor: 'Floor 1',
    floorUid: 'floor-1',
    filter: [],
    logic: [],
    parent: [],
    package: [],
    rect: null,
    labels: [],
    ...partial
  };
}
