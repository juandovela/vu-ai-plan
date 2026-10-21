/**
 * geometryRules.ts
 *
 * Rules based on where options are drawn instead of what they are called.
 * Derived from plans already configured by hand:
 *
 *  - two options that cover the same space can not both be on
 *    (Elevation D / E, Separate Tub and Shower / Shower in lieu of Tub,
 *    Door at Den / Bedroom 5)
 *  - an option located at a room that only exists inside another option
 *    depends on it (Shower at Bath 3 needs Bedroom 5 with Bath 3)
 *
 * @package plan-vu-ui/src/ai/logicAssist
 */

import { includes } from './util';

import {
  areComplements,
  displayName,
  locationsOf,
  normalizeKey,
  sharesLogicGroup
} from './ruleHelpers';
import type {
  IFLogicAssistItem,
  IFLogicAssistRect,
  IFRuleContext,
  LogicAssistOp
} from './types';

/**
 * Share of the smaller drawing covered by the other one.
 */
const OVERLAP_THRESHOLD = 0.9;

/**
 * Above this, with drawings of similar size, there is no doubt.
 */
const STRONG_OVERLAP = 0.95;
const SIMILAR_SIZE = 0.5;

/**
 * A drawing much smaller than the other one that lies inside it is not
 * necessarily in conflict: "Enlarged Bedrooms 2 and 3" is drawn over the whole
 * floor and every window of that floor is inside it, yet only some of them are
 * replaced by it. Such pairs are not merged into one group (a big drawing
 * would chain everything together), each one is offered alone, as a doubt.
 */
const CONTAINED_SIZE = 0.3;

function compare(a: IFLogicAssistRect, b: IFLogicAssistRect) {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  const smaller = Math.min(areaA, areaB);

  if (width <= 0 || height <= 0 || smaller <= 0) {
    return { overlap: 0, sizeRatio: 0 };
  }

  return {
    overlap: (width * height) / smaller,
    sizeRatio: smaller / Math.max(areaA, areaB)
  };
}

const sharesLocation = (a: IFLogicAssistItem, b: IFLogicAssistItem) => {
  const locations = locationsOf(displayName(b));

  return locationsOf(displayName(a)).some(location =>
    includes(locations, location)
  );
};

/**
 * "Shower in lieu of Tub at Bath 3": Bath 3 is not a room of the floor, it
 * is drawn by Bedroom 5 with Bath 3, so the shower only exists with it.
 */
export function locationNestSuggestions(
  items: IFLogicAssistItem[],
  context: IFRuleContext
): LogicAssistOp[] {
  const ops: LogicAssistOp[] = [];

  items.forEach(child => {
    const floorLabels = child.floorUid ? context.floorLabels[child.floorUid] : null;

    /**
     * Without the floor's own labels there is nothing to compare against.
     */
    if (!child.floorUid || !floorLabels || floorLabels.length === 0) {
      return;
    }

    locationsOf(displayName(child)).forEach(location => {
      if (includes(floorLabels, location)) {
        return;
      }

      const owners = items.filter(
        other =>
          other.uid !== child.uid &&
          other.floorUid === child.floorUid &&
          other.labels.some(label => normalizeKey(label) === location)
      );

      if (owners.length !== 1 || includes(child.parent, owners[0].uid)) {
        return;
      }

      const id = `nest:${child.uid}:${owners[0].uid}`;

      if (ops.some(op => op.id === id)) {
        return;
      }

      const room = owners[0].labels.find(label => normalizeKey(label) === location);

      ops.push({
        id,
        kind: 'nest',
        childUid: child.uid,
        parentUid: owners[0].uid,
        reason: `"${room}" is only drawn by "${displayName(owners[0])}".`,
        confidence: 'high',
        source: 'rules'
      });
    });
  });

  return ops;
}

/**
 * Options of one floor whose drawings cover each other.
 */
export function overlapSuggestions(
  items: IFLogicAssistItem[],
  context: IFRuleContext
): LogicAssistOp[] {
  const nests = locationNestSuggestions(items, context).map(op => op.id);
  const root = items.map((_item, index) => index);
  const find = (index: number): number =>
    root[index] === index ? index : (root[index] = find(root[index]));

  const pairs: Array<{ a: number; b: number; overlap: number; strong: boolean }> = [];
  const contained: Array<{ a: number; b: number; overlap: number }> = [];

  items.forEach((a, i) => {
    items.forEach((b, j) => {
      if (j <= i || !a.rect || !b.rect || !a.floorUid || a.floorUid !== b.floorUid) {
        return;
      }

      const { overlap, sizeRatio } = compare(a.rect, b.rect);

      if (overlap < OVERLAP_THRESHOLD || areComplements(a, b)) {
        return;
      }

      const dependent =
        includes(nests, `nest:${a.uid}:${b.uid}`) ||
        includes(nests, `nest:${b.uid}:${a.uid}`) ||
        includes(a.parent, b.uid) ||
        includes(b.parent, a.uid);

      if (dependent) {
        return;
      }

      if (sizeRatio < CONTAINED_SIZE && !sharesLocation(a, b)) {
        contained.push({ a: i, b: j, overlap });

        return;
      }

      pairs.push({
        a: i,
        b: j,
        overlap,
        strong:
          (overlap >= STRONG_OVERLAP && sizeRatio >= SIMILAR_SIZE) ||
          sharesLocation(a, b)
      });
      root[find(i)] = find(j);
    });
  });

  const ops: LogicAssistOp[] = [];
  const roots = items
    .map((_item, index) => find(index))
    .filter((value, index, all) => all.indexOf(value) === index);

  roots.forEach(groupRoot => {
    const members = items.filter((_item, index) => find(index) === groupRoot);
    const groupPairs = pairs.filter(pair => find(pair.a) === groupRoot);

    if (members.length < 2 || sharesLogicGroup(members)) {
      return;
    }

    const lowest = Math.min(...groupPairs.map(pair => pair.overlap));
    const strong = groupPairs.every(pair => pair.strong);
    const floor = members[0].floor ? ` on ${members[0].floor}` : '';

    ops.push({
      id: `logicGroup:${members.map(item => item.uid).join('+')}`,
      kind: 'logicGroup',
      listItemUids: members.map(item => item.uid),
      reason: `Drawn over the same space${floor} (${Math.round(
        lowest * 100
      )}% overlap), only one can be on.`,
      confidence: strong ? 'high' : 'medium',
      source: 'rules'
    });
  });

  /**
   * Offered one by one and with low confidence: the person decides which of
   * them the big drawing really replaces.
   */
  const areaOf = (item: IFLogicAssistItem) => (item.rect ? item.rect.w * item.rect.h : 0);

  contained.forEach(({ a, b, overlap }) => {
    const first = items[a];
    const second = items[b];
    const together = ops.some(
      op => op.kind === 'logicGroup' && includes(op.listItemUids, first.uid) && includes(op.listItemUids, second.uid)
    );

    if (together || sharesLogicGroup([first, second])) {
      return;
    }

    const [small, big] = areaOf(first) <= areaOf(second) ? [first, second] : [second, first];

    ops.push({
      id: `logicGroup:${first.uid}+${second.uid}`,
      kind: 'logicGroup',
      listItemUids: [first.uid, second.uid],
      reason: `"${displayName(small)}" is drawn inside "${displayName(big)}" (${Math.round(
        overlap * 100
      )}% of it): check whether the second one replaces it.`,
      confidence: 'low',
      source: 'rules'
    });
  });

  return ops;
}
