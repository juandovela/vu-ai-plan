/**
 * validateOperations.ts
 *
 * The AI answer is untrusted input: drop anything that points at a list item
 * or floor that does not exist, or at a filter the Logic panel does not have.
 *
 * @package plan-vu-ui/src/ai/logicAssist
 */

import { includes } from './util';

import type { LogicAssistOp } from './types';

export const VALID_FILTERS = [
  'hide',
  'studio',
  'studio-only',
  'elevation',
  'default',
  'unlisted',
  'preselected',
  'not-available'
];

export function validateOperations(
  operations: LogicAssistOp[],
  listItemUids: string[],
  floorUids: string[],
  elevationUids: string[]
): LogicAssistOp[] {
  const known = (uid: string) => includes(listItemUids, uid);

  return operations.filter(op => {
    switch (op.kind) {
      case 'rename':
        return known(op.listItemUid) && op.to.trim().length > 0;
      case 'filter':
        return known(op.listItemUid) && includes(VALID_FILTERS, op.filter);
      case 'logicGroup':
        return op.listItemUids.length > 1 && op.listItemUids.every(known);
      case 'package':
        return op.listItemUids.length === 2 && op.listItemUids.every(known);
      case 'nest':
        return (
          known(op.childUid) && known(op.parentUid) && op.childUid !== op.parentUid
        );
      case 'floor':
        return known(op.listItemUid) && includes(floorUids, op.floorUid);
      case 'elevationPackage':
        return (
          includes(elevationUids, op.elevationUid) &&
          op.listItemUids.length > 0 &&
          op.listItemUids.every(known)
        );
      default:
        return false;
    }
  });
}
