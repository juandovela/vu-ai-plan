/**
 * nameRules.ts
 *
 * Rules that only need names. They are the ones that work on plans made of
 * a single svg, where options have no drawing of their own to measure.
 * Derived from plans already configured by hand:
 *
 *  - every option has a default version (a "Def. X" item, or an item with the
 *    same name) that shares its logic group, so choosing one turns off
 *    the other
 *  - options of the same kind at the same place are alternatives
 *    (Framed / Glass / Separate shower at Owner's Bath)
 *  - an option located at a room that another option adds depends on it
 *    (Shower at Bath 4 needs "Bedroom 6 & Bath 4")
 *
 * @package plan-vu-ui/src/ai/logicAssist
 */

import { includes } from './util';

import {
  areComplements,
  displayName,
  featuresOf,
  headTokens,
  locationsOf,
  normalizeKey,
  sharesLogicGroup
} from './ruleHelpers';
import type { IFLogicAssistItem, LogicAssistOp } from './types';

const sameFloor = (a: IFLogicAssistItem, b: IFLogicAssistItem) =>
  a.floorUid === b.floorUid;

/**
 * "Def. Shower at Bath 2" and "Shower at Bath 2" are the same thing.
 */
const withoutDefault = (name: string) =>
  normalizeKey(name.replace(/^\s*(def\.?|default)\s+/i, ''));

const digitsOf = (value: string) => value.replace(/[^0-9]/g, '');

/**
 * Number of single character edits between two strings.
 */
function distance(a: string, b: string): number {
  const row: number[] = [];

  for (let j = 0; j <= b.length; j++) {
    row[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      previous = current;
    }
  }

  return row[b.length];
}

/**
 * Same name, or one typo apart ("Bat Top" / "Bar Top"). Numbers must match so
 * "Shower at Bath 2" is never taken for "Shower at Bath 3".
 */
function isSameName(a: string, b: string) {
  const keyA = withoutDefault(a);
  const keyB = withoutDefault(b);

  return (
    keyA === keyB ||
    (keyA.length >= 12 && digitsOf(keyA) === digitsOf(keyB) && distance(keyA, keyB) <= 1)
  );
}

/**
 * Same kind of thing at the same place, as another option.
 */
function alternativesOf(option: IFLogicAssistItem, options: IFLogicAssistItem[]) {
  const locations = locationsOf(displayName(option));
  const tokens = headTokens(displayName(option));

  return options.filter(
    other =>
      other.uid !== option.uid &&
      sameFloor(other, option) &&
      !areComplements(other, option) &&
      locationsOf(displayName(other)).some(location => includes(locations, location)) &&
      headTokens(displayName(other)).some(token => includes(tokens, token))
  );
}

export const groupOp = (
  items: IFLogicAssistItem[],
  uids: string[],
  reason: string,
  confidence: 'high' | 'medium'
): LogicAssistOp => {
  const ordered = items.filter(item => includes(uids, item.uid)).map(item => item.uid);

  return {
    id: `logicGroup:${ordered.join('+')}`,
    kind: 'logicGroup',
    listItemUids: ordered,
    reason,
    confidence,
    source: 'rules'
  };
};

/**
 * The default version of an option is an item of the plan itself, not
 * something to create: it only needs to share the option's logic group, and
 * the group of the alternatives of that option that have no default of
 * their own (the default doors are off when either the double or the french
 * doors are on).
 */
export function defaultVersionSuggestions(items: IFLogicAssistItem[]): LogicAssistOp[] {
  const ops: LogicAssistOp[] = [];
  const options = items.filter(item => item.kind === 'option');
  const structures = items.filter(item => item.kind === 'structure');

  options.forEach(option => {
    structures
      .filter(
        structure =>
          sameFloor(structure, option) &&
          isSameName(displayName(structure), displayName(option))
      )
      .forEach(structure => {
        if (!sharesLogicGroup([option, structure])) {
          ops.push(
            groupOp(
              items,
              [option.uid, structure.uid],
              `"${displayName(structure)}" is the default version of "${displayName(option)}".`,
              'high'
            )
          );
        }

        /**
         * Only for alternatives without a default of their own: Double and
         * French doors share one "Def.", while Center and Open Corner
         * sliding doors each have theirs.
         */
        alternativesOf(option, options)
          .filter(
            alternative =>
              !structures.some(
                other =>
                  sameFloor(other, alternative) &&
                  isSameName(displayName(other), displayName(alternative))
              )
          )
          .forEach(alternative => {
          if (!sharesLogicGroup([alternative, structure])) {
            ops.push(
              groupOp(
                items,
                [alternative.uid, structure.uid],
                `"${displayName(alternative)}" replaces the default "${displayName(structure)}".`,
                'high'
              )
            );
          }
        });
      });
  });

  return ops;
}

/**
 * Same kind of thing at the same place, ex. three showers at the Owner's Bath.
 * Naming the place is required: "Stair Rail - Location 1/2/3" share words but
 * are independent.
 */
export function sameLocationAlternativeSuggestions(
  items: IFLogicAssistItem[]
): LogicAssistOp[] {
  const ops: LogicAssistOp[] = [];
  const options = items.filter(item => item.kind === 'option');

  options.forEach(option => {
    alternativesOf(option, options).forEach(other => {
      if (other.uid < option.uid || sharesLogicGroup([option, other])) {
        return;
      }

      ops.push(
        groupOp(
          items,
          [option.uid, other.uid],
          `"${displayName(option)}" and "${displayName(other)}" are the same kind of option at the same place, only one can be on.`,
          'medium'
        )
      );
    });
  });

  return ops;
}

/**
 * "Shower at Bath 4": Bath 4 is added by "Bedroom 6 & Bath 4".
 */
export function addedRoomNestSuggestions(items: IFLogicAssistItem[]): LogicAssistOp[] {
  const ops: LogicAssistOp[] = [];
  const options = items.filter(item => item.kind === 'option');

  options.forEach(child => {
    locationsOf(displayName(child)).forEach(location => {
      const owners = options.filter(
        owner =>
          owner.uid !== child.uid &&
          sameFloor(owner, child) &&
          includes(featuresOf(displayName(owner)), location) &&
          !includes(locationsOf(displayName(owner)), location)
      );

      if (owners.length !== 1 || includes(child.parent, owners[0].uid)) {
        return;
      }

      ops.push({
        id: `nest:${child.uid}:${owners[0].uid}`,
        kind: 'nest',
        childUid: child.uid,
        parentUid: owners[0].uid,
        reason: `"${displayName(owners[0])}" adds the room "${displayName(child)
          .split(/\s+at\s+/i)
          .pop()}".`,
        confidence: 'high',
        source: 'rules'
      });
    });
  });

  return ops;
}

/**
 * Rooms that a bedroom option takes over when it is chosen.
 */
const FLEX_ROOMS = ['den', 'flex', 'study', 'office', 'loft', 'gameroom', 'bonusroom', 'library'];

/**
 * "Bedroom 6 & Bath 4" is built where the Den is, so the Den and every
 * option located at the Den (its doors) can not be on at the same time.
 */
export function flexRoomReplacementSuggestions(
  items: IFLogicAssistItem[]
): LogicAssistOp[] {
  const ops: LogicAssistOp[] = [];
  const options = items.filter(item => item.kind === 'option');

  options
    .filter(option =>
      featuresOf(displayName(option)).some(feature => feature.indexOf('bedroom') === 0)
    )
    .forEach(bedroom => {
      const rooms = items.filter(
        item =>
          item.kind === 'structure' &&
          sameFloor(item, bedroom) &&
          includes(FLEX_ROOMS, normalizeKey(displayName(item)))
      );

      /**
       * With two flex rooms on a floor there is no telling which one it is.
       */
      if (rooms.length !== 1) {
        return;
      }

      const room = rooms[0];
      const roomKey = normalizeKey(displayName(room));
      const located = options.filter(
        option =>
          option.uid !== bedroom.uid &&
          sameFloor(option, bedroom) &&
          includes(locationsOf(displayName(option)), roomKey)
      );

      if (!sharesLogicGroup([bedroom, room])) {
        ops.push(
          groupOp(
            items,
            [bedroom.uid, room.uid],
            `"${displayName(bedroom)}" adds a bedroom where the "${displayName(room)}" is.`,
            'medium'
          )
        );
      }

      if (located.length > 0 && !sharesLogicGroup([bedroom].concat(located))) {
        ops.push(
          groupOp(
            items,
            [bedroom.uid].concat(located.map(option => option.uid)),
            `The "${displayName(room)}" is replaced by "${displayName(bedroom)}", so options located there can not be on.`,
            'medium'
          )
        );
      }
    });

  return ops;
}
