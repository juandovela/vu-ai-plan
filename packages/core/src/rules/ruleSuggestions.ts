/**
 * ruleSuggestions.ts
 *
 * Deterministic suggestions, no AI involved. They run instantly, are the
 * baseline the AI is compared against, and are sent to the AI so it does not
 * repeat them.
 *
 * @package plan-vu-ui/src/ai/logicAssist
 */

import { includes } from './util';
import { groupBy } from './util';

import { elevationPackageSuggestions } from './elevationRules';
import { overlapSuggestions, locationNestSuggestions } from './geometryRules';
import {
  addedRoomNestSuggestions,
  defaultVersionSuggestions,
  flexRoomReplacementSuggestions,
  sameLocationAlternativeSuggestions
} from './nameRules';
import {
  baseKey,
  displayName,
  normalizeKey,
  sharesLogicGroup
} from './ruleHelpers';
import type {
  IFElevationInfo,
  IFLogicAssistItem,
  IFLogicAssistRect,
  IFRuleContext,
  LogicAssistOp
} from './types';

/**
 * Abbreviations used in layer names. Sent to the AI as context; per client
 * conventions differ ("Optional" vs "Opt", "ILO" vs "ilo").
 */
export const DEFAULT_GLOSSARY: { [abbreviation: string]: string } = {
  opt: 'optional',
  ilo: 'in lieu of',
  w: 'with',
  '@': 'at'
};

const withoutX = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/x/g, '');

const readable = (value: string) =>
  value
    .replace(/\b(opt|optional|standard)\b/gi, ' ')
    .replace(/[\s-]+/g, ' ')
    .trim();

export function buildRuleSuggestions(
  allItems: IFLogicAssistItem[],
  context: IFRuleContext
): LogicAssistOp[] {
  /**
   * Structure items are rooms and default versions. They only take part in
   * the default version rule; the rest looks at options.
   */
  const items = allItems.filter(item => item.kind === 'option');

  return withoutRedundantGroups(
    uniqueById([
      ...renameSuggestions(items),
      ...standardPairSuggestions(items),
      ...elevationSuggestions(items),
      ...defaultVersionSuggestions(allItems),
      ...flexRoomReplacementSuggestions(allItems),
      ...overlapSuggestions(items, context),
      ...sameLocationAlternativeSuggestions(items),
      ...locationNestSuggestions(items, context),
      ...addedRoomNestSuggestions(items),
      ...nestSuggestions(items),
      ...elevationPackageSuggestions(items, context.elevations)
    ])
  );
}

function uniqueById(ops: LogicAssistOp[]): LogicAssistOp[] {
  const seen: string[] = [];

  return ops.filter(op => {
    if (includes(seen, op.id)) {
      return false;
    }

    seen.push(op.id);
    return true;
  });
}

/**
 * Two rules can find the same alternatives with a different member count.
 * Keep the biggest group and drop the ones it already contains.
 */
function withoutRedundantGroups(ops: LogicAssistOp[]): LogicAssistOp[] {
  const groups = ops.filter(
    (op): op is Extract<LogicAssistOp, { kind: 'logicGroup' }> =>
      op.kind === 'logicGroup'
  );

  return ops.filter(op => {
    if (op.kind !== 'logicGroup') {
      return true;
    }

    return !groups.some(
      other =>
        other.id !== op.id &&
        other.listItemUids.length > op.listItemUids.length &&
        op.listItemUids.every(uid => includes(other.listItemUids, uid))
    );
  });
}

/**
 * The svg id keeps the characters the list item name lost.
 */
function renameSuggestions(items: IFLogicAssistItem[]): LogicAssistOp[] {
  const ops: LogicAssistOp[] = [];

  items.forEach(item => {
    if (!item.originalName || item.originalName === item.name) {
      return;
    }

    /**
     * Same letters and numbers => only punctuation was lost, safe to apply.
     * The export turns a hyphen into an "X" in some names (DropXin), so x
     * is ignored in the comparison.
     * Otherwise the name may have been edited by hand, so ask first.
     */
    const cosmetic = withoutX(item.originalName) === withoutX(item.name);

    ops.push({
      id: `rename:${item.uid}`,
      kind: 'rename',
      listItemUid: item.uid,
      from: item.name,
      to: item.originalName,
      reason: cosmetic
        ? 'Restores punctuation lost from the layer name.'
        : 'Layer name differs from the current name.',
      confidence: cosmetic ? 'high' : 'medium',
      source: 'rules'
    });
  });

  return ops;
}

/**
 * "Gourmet Kitchen - Standard" and "Opt Gourmet Kitchen" are the same
 * thing, only one can be on.
 */
function standardPairSuggestions(items: IFLogicAssistItem[]): LogicAssistOp[] {
  const ops: LogicAssistOp[] = [];
  const groups = groupBy(
    items,
    item => `${item.floorUid}|${baseKey(displayName(item))}`
  );

  Object.keys(groups).forEach(key => {
    const group = groups[key];
    const standards = group.filter(item => /\bstandard\b/i.test(displayName(item)));

    if (group.length < 2 || standards.length === 0 || standards.length === group.length) {
      return;
    }

    if (!sharesLogicGroup(group)) {
      ops.push({
        id: `logicGroup:${group.map(item => item.uid).join('+')}`,
        kind: 'logicGroup',
        listItemUids: group.map(item => item.uid),
        reason: `Standard and optional version of "${readable(displayName(group[0]))}".`,
        confidence: 'high',
        source: 'rules'
      });
    }

    standards.forEach(item => {
      if (!includes(item.filter, 'default')) {
        ops.push({
          id: `filter:${item.uid}:default`,
          kind: 'filter',
          listItemUid: item.uid,
          filter: 'default',
          reason: 'Standard version is on by default.',
          confidence: 'medium',
          source: 'rules'
        });
      }
    });
  });

  return ops;
}

/**
 * Elevations on the same floor: one at a time.
 */
function elevationSuggestions(items: IFLogicAssistItem[]): LogicAssistOp[] {
  const ops: LogicAssistOp[] = [];
  const elevations = items.filter(item => /\belevation\b/i.test(displayName(item)));
  const byFloor = groupBy(elevations, item => String(item.floorUid));

  Object.keys(byFloor).forEach(floorUid => {
    const group = byFloor[floorUid];

    if (group.length > 1 && !sharesLogicGroup(group)) {
      ops.push({
        id: `logicGroup:${group.map(item => item.uid).join('+')}`,
        kind: 'logicGroup',
        listItemUids: group.map(item => item.uid),
        reason: `${group.length} elevations on ${group[0].floor ?? 'the same floor'}, only one can be on.`,
        confidence: 'high',
        source: 'rules'
      });
    }
  });

  elevations.forEach(item => {
    if (!includes(item.filter, 'elevation')) {
      ops.push({
        id: `filter:${item.uid}:elevation`,
        kind: 'filter',
        listItemUid: item.uid,
        filter: 'elevation',
        reason:
          'Name says it is an elevation. Not used in the plans reviewed, check before applying.',
        confidence: 'medium',
        source: 'rules'
      });
    }
  });

  return ops;
}

/**
 * "(Only Available with Covered Outdoor Living 3)" is a dependency written
 * in the name.
 */
function nestSuggestions(items: IFLogicAssistItem[]): LogicAssistOp[] {
  const ops: LogicAssistOp[] = [];
  const pattern = /\((?:only\s+)?(?:available|requires?)\s+(?:with|at|when|on)?\s*([^)]+)\)/i;

  items.forEach(item => {
    const match = pattern.exec(displayName(item));

    if (!match) {
      return;
    }

    const wanted = baseKey(match[1]);
    const others = items.filter(other => other.uid !== item.uid);
    const exact = others.find(other => baseKey(displayName(other)) === wanted);
    const partial = others.find(other => {
      const key = baseKey(displayName(other));
      return key.length > 0 && (key.indexOf(wanted) > -1 || wanted.indexOf(key) > -1);
    });
    const parent = exact ?? partial;

    if (!parent || includes(item.parent, parent.uid)) {
      return;
    }

    ops.push({
      id: `nest:${item.uid}:${parent.uid}`,
      kind: 'nest',
      childUid: item.uid,
      parentUid: parent.uid,
      reason: `Name says it is only available with "${match[1].trim()}".`,
      confidence: exact ? 'high' : 'medium',
      source: 'rules'
    });
  });

  return ops;
}
