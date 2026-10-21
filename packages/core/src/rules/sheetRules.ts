/**
 * sheetRules.ts
 *
 * Matches what the plan sheet (PDF) says against the plan being configured.
 * What the sheet states directly is the strongest evidence there is, so what
 * comes out of here is more reliable than guessing from names:
 *
 *  - the sheet's wording and location for each option ("Covered Patio at
 *    Dining" while the layer says "Great Room")
 *  - rooms an option replaces (Den) and adds (Bath 3), which decide what is
 *    exclusive and what depends on what
 *  - options the sheet lists and the plan lacks, and the other way around
 *
 * @package plan-vu-ui/src/ai/logicAssist
 */

import { includes } from './util';

import { groupOp } from './nameRules';
import { displayName, locationsOf, normalizeKey } from './ruleHelpers';
import type {
  IFLogicAssistItem,
  IFPlanSheet,
  IFSheetFinding,
  IFSheetOption,
  LogicAssistOp
} from './types';

/**
 * Share of the sheet's options that has to match the plan to trust the sheet.
 */
const MIN_MATCHED = 0.5;

const STOP = ['a', 'an', 'the', 'of', 'in', 'at', 'with', 'and', 'opt', 'optional'];

/**
 * "Shower I.L.O. Tub" and "Shower in lieu of Tub" are the same words.
 */
const tokens = (value: string) =>
  value
    .toLowerCase()
    .replace(/\bi\.l\.o\b\.?|\bilo\b/g, ' in lieu of ')
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 0 && !includes(STOP, token));

function jaccard(a: string[], b: string[]) {
  if (a.length === 0 && b.length === 0) {
    return 1;
  }

  const shared = a.filter(token => includes(b, token)).length;

  return shared / (a.length + b.length - shared);
}

const isSubset = (a: string[], b: string[]) =>
  a.length > 0 && b.length > 0 && (a.every(t => includes(b, t)) || b.every(t => includes(a, t)));

/**
 * "Optional Shower in lieu Tub at Bath 3" => prefix, head and location.
 */
function splitName(name: string) {
  const prefix = (/^\s*(optional|opt)\s+/i.exec(name) || [''])[0];
  const rest = name.slice(prefix.length);
  const at = rest.toLowerCase().lastIndexOf(' at ');

  return at === -1
    ? { prefix, head: rest, location: '' }
    : { prefix, head: rest.slice(0, at), location: rest.slice(at + 4) };
}

const isElevation = (item: IFLogicAssistItem) => /\belevation\b/i.test(displayName(item));

const elevationLetter = (name: string) => {
  const match = /\belevation\s+([a-z0-9]+)\b/i.exec(name);

  return match ? match[1].toLowerCase() : null;
};

const alnum = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

interface IFMatch {
  sheetIndex: number;
  item: IFLogicAssistItem;
  headSim: number;
  locSim: number;
  locationOk: boolean;
  parts: { prefix: string; head: string; location: string };
}

export function buildSheetSuggestions(
  items: IFLogicAssistItem[],
  floors: Array<{ uid: string; floorNumber: number }>,
  sheet: IFPlanSheet
): { ops: LogicAssistOp[]; findings: IFSheetFinding[] } {
  const ops: LogicAssistOp[] = [];
  const findings: IFSheetFinding[] = [];
  const options = items.filter(item => item.kind === 'option' && !isElevation(item));

  /**
   * Every sheet option against every plan option of its floor, best pairs
   * first, each one used once.
   */
  const candidates: IFMatch[] = [];

  sheet.options.forEach((sheetOption, sheetIndex) => {
    const floorUid = floors.find(floor => floor.floorNumber === sheetOption.floorNumber)?.uid;

    options
      .filter(item => !floorUid || item.floorUid === floorUid)
      .forEach(item => {
        const parts = splitName(displayName(item));
        const headSim = jaccard(tokens(sheetOption.name), tokens(parts.head));

        if (headSim < 0.6) {
          return;
        }

        const locationTokens = tokens(parts.location);
        const sheetLocation = tokens(sheetOption.location);

        candidates.push({
          sheetIndex,
          item,
          headSim,
          locSim: jaccard(sheetLocation, locationTokens),
          locationOk:
            jaccard(sheetLocation, locationTokens) >= 0.5 ||
            isSubset(sheetLocation, locationTokens),
          parts
        });
      });
  });

  candidates.sort((a, b) => b.headSim * 2 + b.locSim - (a.headSim * 2 + a.locSim));

  const bySheet: { [index: number]: IFMatch } = {};
  const taken: string[] = [];

  candidates.forEach(candidate => {
    if (!bySheet[candidate.sheetIndex] && !includes(taken, candidate.item.uid)) {
      bySheet[candidate.sheetIndex] = candidate;
      taken.push(candidate.item.uid);
    }
  });

  /**
   * A sheet that barely matches is most likely from another plan. Suggesting
   * changes from it would only do harm.
   */
  const matched = Object.keys(bySheet).length;

  if (sheet.options.length > 0 && matched / sheet.options.length < MIN_MATCHED) {
    return {
      ops: [],
      findings: [
        {
          id: 'sheet-mismatch',
          severity: 'warning',
          message: `Only ${matched} of the ${sheet.options.length} options in the sheet match this plan${
            sheet.planName ? ` (the sheet is "${sheet.planName}")` : ''
          }. Is it the right PDF? Nothing was suggested from it.`
        }
      ]
    };
  }

  /**
   * Insets that show several options together: the team merges them into
   * one option, which is a change to the drawing, not something to apply here.
   */
  const insetMembers: { [key: string]: IFSheetOption[] } = {};

  sheet.options.forEach((sheetOption, index) => {
    if (bySheet[index] && sheetOption.insetKey) {
      (insetMembers[sheetOption.insetKey] = insetMembers[sheetOption.insetKey] || []).push(
        sheetOption
      );
    }
  });

  Object.keys(insetMembers).forEach(key => {
    const members = insetMembers[key];

    if (members.length > 1) {
      findings.push({
        id: `inset:${key}`,
        severity: 'info',
        message: `The sheet shows ${members
          .map(member => `"${member.name}"`)
          .join(' and ')} together as "${members[0].caption ?? key}". Plans are usually built with them as one option.`
      });
    }
  });

  sheet.options.forEach((sheetOption, index) => {
    const match = bySheet[index];

    if (!match) {
      findings.push({
        id: `missing:${index}`,
        severity: 'warning',
        message:
          sheetOption.marker === '*'
            ? `"${sheetOption.name} at ${sheetOption.location}" is marked as not drawn on the sheet, it has to be created by hand.`
            : `The sheet lists "${sheetOption.name} at ${sheetOption.location}" but no layer matches it.`
      });
      return;
    }

    const shared =
      !!sheetOption.insetKey && (insetMembers[sheetOption.insetKey] || []).length > 1;
    const expected = `${sheetOption.name} at ${sheetOption.location}`;
    const current = `${match.parts.head} at ${match.parts.location}`;

    if (!shared && alnum(expected) !== alnum(current)) {
      ops.push({
        id: `rename:${match.item.uid}`,
        kind: 'rename',
        listItemUid: match.item.uid,
        from: match.item.name,
        to: match.parts.prefix + expected,
        reason: match.locationOk
          ? 'The sheet words it differently.'
          : `The sheet places it at "${sheetOption.location}", the layer says "${match.parts.location}".`,
        confidence: 'medium',
        source: 'pdf'
      });
    }

    if (sheetOption.marker === '**') {
      ops.push({
        id: `filter:${match.item.uid}:not-available`,
        kind: 'filter',
        listItemUid: match.item.uid,
        filter: 'not-available',
        reason: 'The sheet marks it as not available on every homesite.',
        confidence: 'medium',
        source: 'pdf'
      });
    }

    /**
     * Rooms the option takes away: it excludes whatever is located there.
     */
    sheetOption.replaces.forEach(room => {
      const located = options.filter(
        item =>
          item.uid !== match.item.uid &&
          item.floorUid === match.item.floorUid &&
          includes(locationsOf(displayName(item)), normalizeKey(room))
      );

      if (located.length > 0) {
        ops.push({
          ...groupOp(
            items,
            [match.item.uid].concat(located.map(item => item.uid)),
            `The sheet says "${sheetOption.name}" replaces the ${room}, so options located there can not be on.`,
            'high'
          ),
          source: 'pdf'
        });
      }
    });

    /**
     * Rooms the option creates: whatever is located there depends on it.
     */
    sheetOption.adds.forEach(room => {
      options
        .filter(
          item =>
            item.uid !== match.item.uid &&
            item.floorUid === match.item.floorUid &&
            includes(locationsOf(displayName(item)), normalizeKey(room)) &&
            !includes(item.parent, match.item.uid)
        )
        .forEach(item => {
          ops.push({
            id: `nest:${item.uid}:${match.item.uid}`,
            kind: 'nest',
            childUid: item.uid,
            parentUid: match.item.uid,
            reason: `The sheet says "${sheetOption.name}" adds the ${room}.`,
            confidence: 'high',
            source: 'pdf'
          });
        });
    });
  });

  options
    .filter(item => !includes(taken, item.uid))
    .forEach(item =>
      findings.push({
        id: `unlisted:${item.uid}`,
        severity: 'warning',
        message: `"${item.name}" is not in the sheet's options.`
      })
    );

  const sheetLetters = sheet.elevations.map(name => elevationLetter(name));

  items.filter(isElevation).forEach(item => {
    const letter = elevationLetter(displayName(item));

    if (letter && !includes(sheetLetters, letter)) {
      findings.push({
        id: `elevation:${item.uid}`,
        severity: 'warning',
        message: `"${item.name}" is not one of the sheet's elevations (${sheet.elevations.join(', ')}).`
      });
    }
  });

  sheet.elevations.forEach(name => {
    const letter = elevationLetter(name);

    if (letter && !items.some(item => isElevation(item) && elevationLetter(displayName(item)) === letter)) {
      findings.push({
        id: `elevation-standard:${letter}`,
        severity: 'info',
        message: `${name} has no option layers, so it is the standard elevation.`
      });
    }
  });

  return { ops, findings };
}
