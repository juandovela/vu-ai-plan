/**
 * elevationRules.ts
 *
 * An elevation image and its "Optional Elevation D at Floor N" options are
 * the same choice. The elevation asset keeps their list item uids in
 * `package`: turning one on switches the other. Plans arrive with it empty.
 *
 * @package plan-vu-ui/src/ai/logicAssist
 */

import { includes } from './util';

import { displayName } from './ruleHelpers';
import type { IFElevationInfo, IFLogicAssistItem, LogicAssistOp } from './types';

/**
 * "Elevation D" / "Optional Elevation D at Floor 1" => "d"
 */
const elevationKey = (name: string) => {
  const match = /\belevation\s+([a-z0-9]+)\b/i.exec(name);

  return match ? match[1].toLowerCase() : null;
};

export function elevationPackageSuggestions(
  items: IFLogicAssistItem[],
  elevations: IFElevationInfo[]
): LogicAssistOp[] {
  const ops: LogicAssistOp[] = [];

  elevations.forEach(elevation => {
    const key = elevationKey(elevation.name);

    if (!key) {
      return;
    }

    const options = items.filter(item => elevationKey(displayName(item)) === key);
    const missing = options.filter(item => !includes(elevation.package, item.uid));

    if (missing.length === 0) {
      return;
    }

    ops.push({
      id: `elevationPackage:${elevation.uid}`,
      kind: 'elevationPackage',
      elevationUid: elevation.uid,
      listItemUids: elevation.package.concat(missing.map(item => item.uid)),
      reason: `Options named after "${elevation.name}": ${options
        .map(item => item.floor ?? item.name)
        .join(', ')}.`,
      confidence: 'high',
      source: 'rules'
    });
  });

  return ops;
}
