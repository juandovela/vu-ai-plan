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
import { displayName, locationsOf, normalizeKey, sharesLogicGroup } from './ruleHelpers';
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
  // the sheet prints the letter in quotes: Elevation ‘B’
  const match = /\belevation\s+['"‘’“”]?([a-z0-9]+)['"‘’“”]?(?![a-z0-9])/i.exec(name);

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


/**
 * The options of the plan a note is talking about. The note says them the way
 * the options table does ("Fireplace at Family"), the plan has its own words
 * ("Optional Fireplace at Family"): all the words of the shorter one have to
 * be in the longer one, or they have to be close.
 */
function optionsNamed(
  text: string,
  options: IFLogicAssistItem[],
  resolved: Array<{ label: string; name: string; item: IFLogicAssistItem }>
): IFLogicAssistItem[] {
  const wanted = tokens(text);

  if (wanted.length === 0) {
    return [];
  }

  /**
   * The note speaks the sheet's language, and the options table of the sheet
   * was already matched with the plan, however differently the layer is named.
   */
  const viaSheet = resolved
    .map(entry => ({ item: entry.item, score: jaccard(wanted, tokens(entry.label)) }))
    .filter(entry => entry.score >= 0.8)
    .sort((a, b) => b.score - a.score);

  if (viaSheet.length > 0) {
    return viaSheet.filter(entry => entry.score >= viaSheet[0].score - 0.05).map(entry => entry.item);
  }

  // just the name ("opt. fireplace"): enough when only one option of the table is called that
  const byName = resolved.filter(entry => jaccard(wanted, tokens(entry.name)) >= 0.8);

  if (byName.length === 1) {
    return [byName[0].item];
  }

  const scored = options
    .map(item => {
      const have = tokens(displayName(item));
      const score = jaccard(wanted, have);

      return { item, score: isSubset(wanted, have) && wanted.length >= 2 ? Math.max(score, 0.75) : score };
    })
    .filter(entry => entry.score >= 0.6)
    .sort((a, b) => b.score - a.score);

  return scored.length === 0 ? [] : scored.filter(entry => entry.score >= scored[0].score - 0.05).map(entry => entry.item);
}

const quote = (note: { text: string; page: number | null }) =>
  `${note.page ? `Page ${note.page}: ` : ''}"${note.text.length > 140 ? `${note.text.slice(0, 137)}…` : note.text}"`;

/**
 * What the notes of the sheet ask for. A note that says it plainly becomes a
 * suggestion to apply; the rest is shown, so nobody has to read the sheet
 * again to know what it says about the options.
 */
function noteSuggestions(
  options: IFLogicAssistItem[],
  sheet: IFPlanSheet,
  resolved: Array<{ label: string; name: string; item: IFLogicAssistItem }>
) {
  const ops: LogicAssistOp[] = [];
  const findings: IFSheetFinding[] = [];
  const seen: string[] = [];
  const add = (op: LogicAssistOp) => {
    if (!includes(seen, op.id)) {
      seen.push(op.id);
      ops.push(op);
    }
  };

  sheet.notes.forEach((note, index) => {
    const effect = note.effect ?? 'info';
    const applies = (note.appliesTo ?? []).map(name => {
      const found = optionsNamed(name, options, resolved);
      const wanted = tokens(name);
      // "Door" could be the door at the den or the one at the primary bath: say so instead of "no option"
      const several = found.length > 0 || wanted.length === 0
        ? []
        : options.filter(item => wanted.every(token => includes(tokens(displayName(item)), token)));

      return { name, items: found, several };
    });
    const ambiguous = applies.filter(entry => entry.several.length > 1);
    const unmatched = applies.filter(entry => entry.items.length === 0 && entry.several.length <= 1).map(entry => `"${entry.name}"`);
    const subjects = applies.reduce((all, entry) => all.concat(entry.items), [] as IFLogicAssistItem[]);
    const target = note.target ? optionsNamed(note.target, options, resolved) : [];

    if (effect === 'info' || subjects.length === 0 || ((effect === 'excludes' || effect === 'depends-on') && target.length !== 1)) {
      // nothing to apply: it is shown with what it is about, once per note
      /**
       * Plan labels that say nothing about an option ("low wall", "d/w", "shelf")
       * are read but not shown: the ones worth a look name an option or say
       * "opt." / "option".
       */
      const worth =
        effect !== 'info' ||
        (note.appliesTo ?? []).length > 0 ||
        (note.kind === 'general' && /counselor|not available|verify|contact|see\b|only|requires?/i.test(note.text)) ||
        (note.kind === 'drawing' && /\bopt\b|\bopt\.|optional|option/i.test(note.text));

      if (worth) {
        const about = subjects.length > 0 ? ` Applies to: ${subjects.map(item => `"${item.name}"`).join(', ')}.` : '';
        const lost =
          effect !== 'info' && subjects.length === 0
            ? ' It asks for a change but no option of this plan matches what it names.'
            : effect !== 'info'
            ? ` It asks for a change that could not be matched (${note.target ? `"${note.target}"` : 'no other option named'}).`
            : '';

        findings.push({
          id: `note:${index}`,
          // an information note that names something the plan does not have (a room, an option that is already reported as missing) is not an alarm
          severity: effect === 'info' ? 'info' : 'warning',
          message: `${quote(note)}${about}${lost}${
            unmatched.length > 0 ? ` No option of this plan matches ${unmatched.join(', ')}.` : ''
          }${
            ambiguous.length > 0
              ? ` Could not tell which option it is about: ${ambiguous
                  .map(entry => `"${entry.name}" could be ${entry.several.map(item => `"${item.name}"`).join(' or ')}`)
                  .join('; ')}.`
              : ''
          }`
        });
      }

      return;
    }

    const why = `Note on the sheet. ${quote(note)}`;

    subjects.forEach(item => {
      if (effect === 'not-available' && !includes(item.filter, 'not-available')) {
        add({
          id: `filter:${item.uid}:not-available`,
          kind: 'filter',
          listItemUid: item.uid,
          filter: 'not-available',
          reason: why,
          confidence: 'medium',
          source: 'pdf'
        });
      }

      if (effect === 'hide' && !includes(item.filter, 'hide')) {
        add({
          id: `filter:${item.uid}:hide`,
          kind: 'filter',
          listItemUid: item.uid,
          filter: 'hide',
          reason: why,
          confidence: 'low',
          source: 'pdf'
        });
      }

      if (effect === 'excludes' && target[0].uid !== item.uid && !sharesLogicGroup([item, target[0]])) {
        add({
          ...groupOp(options, [item.uid, target[0].uid], why, 'medium'),
          source: 'pdf'
        });
      }

      if (effect === 'depends-on' && target[0].uid !== item.uid && !includes(item.parent, target[0].uid)) {
        add({
          id: `nest:${item.uid}:${target[0].uid}`,
          kind: 'nest',
          childUid: item.uid,
          parentUid: target[0].uid,
          reason: why,
          confidence: 'medium',
          source: 'pdf'
        });
      }
    });

    if (unmatched.length > 0) {
      findings.push({
        id: `note:${index}:unmatched`,
        severity: 'warning',
        message: `${quote(note)} No option of this plan matches ${unmatched.join(', ')}.`
      });
    }
  });

  return { ops, findings };
}

export function buildSheetSuggestions(
  items: IFLogicAssistItem[],
  floors: Array<{ uid: string; floorNumber: number }>,
  sheet: IFPlanSheet,
  /** Normalised room names each floor draws, to tell a room the option creates from one that is already there. */
  floorLabels: { [floorUid: string]: string[] } = {}
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
    /**
     * The sheet's name can already carry its place ("Double Doors at Den"), and
     * a table heading ("Floor Options") is not a place: in both cases adding
     * the table's location would write something that is not on the sheet.
     */
    const sheetPlace = /\bat\b/i.test(sheetOption.name) || /^floor options?$/i.test(sheetOption.location.trim()) ? '' : sheetOption.location;
    const place = sheetPlace || (/^floor options?$/i.test(sheetOption.location.trim()) ? match.parts.location : '');
    const expected = place ? `${sheetOption.name} at ${place}` : sheetOption.name;
    const current = match.parts.location ? `${match.parts.head} at ${match.parts.location}` : match.parts.head;

    // same option, and the layer places it more precisely than the sheet ("Floor 1 Stairs" for "Stairs"): nothing to fix
    const saysMore =
      sheetPlace.length > 0 &&
      alnum(sheetOption.name) === alnum(match.parts.head) &&
      tokens(sheetPlace).every(token => includes(tokens(match.parts.location), token)) &&
      tokens(match.parts.location).length > tokens(sheetPlace).length;

    if (!shared && !saysMore && alnum(expected) !== alnum(current)) {
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

      // already in one exclusive group together: proposing it again would make a second one
      const together = [match.item].concat(located);

      if (located.length > 0 && !sharesLogicGroup(together)) {
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
      const existing = includes(floorLabels[match.item.floorUid ?? ''] ?? [], normalizeKey(room));

      /**
       * A room the floor already draws (Bath 2 in "Enlarged Bedrooms 2 and 3
       * with Bath 2") is not created by the option, it is redone by it: what is
       * located there can not be on together with it.
       */
      if (existing) {
        const located = options.filter(
          item =>
            item.uid !== match.item.uid &&
            item.floorUid === match.item.floorUid &&
            includes(locationsOf(displayName(item)), normalizeKey(room))
        );

        if (located.length > 0 && !sharesLogicGroup([match.item].concat(located))) {
          ops.push({
            ...groupOp(
              items,
              [match.item.uid].concat(located.map(item => item.uid)),
              `The sheet says "${sheetOption.name}" redoes the ${room}, which the floor already has: options located there can not be on with it.`,
              'medium'
            ),
            source: 'pdf'
          });
        }

        return;
      }

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

  const fromNotes = noteSuggestions(
    options,
    sheet,
    sheet.options.reduce(
      (all, sheetOption, index) =>
        bySheet[index]
          ? all.concat({ label: `${sheetOption.name} at ${sheetOption.location}`, name: sheetOption.name, item: bySheet[index].item })
          : all,
      [] as Array<{ label: string; name: string; item: IFLogicAssistItem }>
    )
  );

  fromNotes.ops.forEach(op => {
    if (!ops.some(existing => existing.id === op.id)) {
      ops.push(op);
    }
  });
  findings.push(...fromNotes.findings);

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
