/**
 * Says why a proposed operation can not be applied, so that whoever proposed
 * it (a rule, the AI, an agent calling a tool) can fix it.
 */

import type { Operation, PlanSnapshot } from './contract';
import { FILTERS } from './contract';

const proposable = FILTERS.filter(filter => filter !== 'none');

/**
 * @returns null when the operation is valid and adds something, otherwise
 * the reason in one sentence.
 */
export function explainInvalid(op: Operation, snapshot: PlanSnapshot): string | null {
  const item = (uid: string) => snapshot.items.find(candidate => candidate.uid === uid);
  const unknown = (uid: string) => `Unknown item "${uid}". Use a uid from list_items.`;

  switch (op.kind) {
    case 'rename': {
      const target = item(op.listItemUid);

      if (!target) return unknown(op.listItemUid);
      if (target.kind !== 'option') return 'Only options are renamed, not structure items.';
      if (op.to.trim() === target.name) return 'The name is already that.';
      return null;
    }

    case 'filter': {
      const target = item(op.listItemUid);

      if (!target) return unknown(op.listItemUid);
      if (proposable.indexOf(op.filter as (typeof proposable)[number]) === -1) {
        return `Filter "${op.filter}" can not be proposed.`;
      }
      if (target.filter.indexOf(op.filter) !== -1) return `"${op.filter}" is already set.`;
      return null;
    }

    case 'logicGroup': {
      const uids = op.listItemUids;

      if (new Set(uids).size < 2) return 'A group needs at least two different items.';
      const missing = uids.find(uid => !item(uid));

      if (missing) return unknown(missing);

      const members = uids.map(uid => item(uid)!);
      const shared = members[0].logic.some(group => members.every(m => m.logic.indexOf(group) !== -1));

      return shared ? 'These items already exclude each other.' : null;
    }

    case 'package': {
      const [a, b] = op.listItemUids;

      if (a === b) return 'Link two different items.';
      if (!item(a)) return unknown(a);
      if (!item(b)) return unknown(b);
      return item(a)!.package.indexOf(b) !== -1 ? 'They are already linked.' : null;
    }

    case 'nest': {
      const child = item(op.childUid);
      const parent = item(op.parentUid);

      if (!child) return unknown(op.childUid);
      if (!parent) return unknown(op.parentUid);
      if (op.childUid === op.parentUid) return 'An item can not depend on itself.';
      if (child.parent.indexOf(op.parentUid) !== -1) return 'It already depends on that item.';

      /**
       * The parent, or anything it depends on however far up, can not
       * depend on the child.
       */
      const seen = new Set<string>();
      const pending = [op.parentUid];

      while (pending.length > 0) {
        const uid = pending.pop() as string;

        if (uid === op.childUid) return 'That would make a cycle: the parent already depends on the child.';
        if (seen.has(uid)) continue;
        seen.add(uid);
        (item(uid)?.parent ?? []).forEach(next => pending.push(next));
      }

      return null;
    }

    case 'floor': {
      if (!item(op.listItemUid)) return unknown(op.listItemUid);
      return snapshot.floors.some(floor => floor.uid === op.floorUid)
        ? null
        : `Unknown floor "${op.floorUid}". Use a uid from list_floors.`;
    }

    case 'elevationPackage': {
      const elevation = snapshot.elevations.find(candidate => candidate.uid === op.elevationUid);

      if (!elevation) return `Unknown elevation "${op.elevationUid}".`;
      const missing = op.listItemUids.find(uid => !item(uid));

      if (missing) return unknown(missing);
      return op.listItemUids.every(uid => elevation.package.indexOf(uid) !== -1)
        ? 'The elevation already switches on all of them.'
        : null;
    }
  }
}
