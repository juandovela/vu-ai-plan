/**
 * A copy of the plan that tools run against. Nothing here touches the real
 * plan: proposals are collected and handed back as operations, and the app
 * decides what to apply.
 */

import type { Operation, PlanItem, PlanSnapshot } from '../contract';
import { explainInvalid } from '../validate';

export type ProposeResult = { ok: true; id: string } | { ok: false; error: string };

export class VirtualPlan {
  readonly snapshot: PlanSnapshot;
  private readonly proposals: Operation[] = [];
  private readonly baseline: Operation[];

  /**
   * @param baseline operations the rules and the sheet already proposed, so
   * the tools can tell a duplicate from something new.
   */
  constructor(snapshot: PlanSnapshot, baseline: Operation[] = []) {
    this.snapshot = structuredClone(snapshot);
    this.baseline = baseline;
  }

  items(): PlanItem[] {
    return this.snapshot.items;
  }

  item(uid: string): PlanItem | undefined {
    return this.snapshot.items.find(item => item.uid === uid);
  }

  baselineOperations(): Operation[] {
    return this.baseline;
  }

  proposed(): Operation[] {
    return this.proposals.slice();
  }

  /**
   * Same order the plan lists its items in, so one proposal always gets one id.
   */
  order(uids: string[]): string[] {
    const position = (uid: string) => this.snapshot.items.findIndex(item => item.uid === uid);

    return Array.from(new Set(uids)).sort((a, b) => position(a) - position(b));
  }

  propose(op: Operation): ProposeResult {
    const reason = explainInvalid(op, this.snapshot);

    if (reason) {
      return { ok: false, error: reason };
    }

    if (this.baseline.some(existing => existing.id === op.id)) {
      return { ok: false, error: `Already proposed by the rules (${op.id}).` };
    }

    if (this.proposals.some(existing => existing.id === op.id)) {
      return { ok: false, error: `Already proposed (${op.id}).` };
    }

    this.proposals.push(op);
    this.applyToCopy(op);

    return { ok: true, id: op.id };
  }

  /**
   * The copy follows what has been proposed, so a tool that reads the plan
   * afterwards sees it, and a later proposal is checked against it (ex. two
   * dependencies that would end in a cycle).
   */
  private applyToCopy(op: Operation): void {
    const items = this.snapshot.items;
    const find = (uid: string) => items.find(item => item.uid === uid);

    switch (op.kind) {
      case 'rename': {
        const item = find(op.listItemUid);

        if (item) item.name = op.to;
        break;
      }

      case 'filter':
        find(op.listItemUid)?.filter.push(op.filter);
        break;

      case 'logicGroup': {
        /**
         * Numbers are only used to tell groups apart inside this copy, the
         * app assigns the real ones when it applies the operation.
         */
        const group = items.reduce((max, item) => Math.max(max, ...item.logic, 0), 0) + 1;

        op.listItemUids.forEach(uid => find(uid)?.logic.push(group));
        break;
      }

      case 'package':
        find(op.listItemUids[0])?.package.push(op.listItemUids[1]);
        find(op.listItemUids[1])?.package.push(op.listItemUids[0]);
        break;

      case 'nest':
        find(op.childUid)?.parent.push(op.parentUid);
        break;

      case 'elevationPackage': {
        const elevation = this.snapshot.elevations.find(candidate => candidate.uid === op.elevationUid);

        if (elevation) {
          elevation.package = Array.from(new Set(elevation.package.concat(op.listItemUids)));
        }
        break;
      }

      case 'floor':
        // the app creates a floor item for it, nothing to read back here
        break;
    }
  }
}
