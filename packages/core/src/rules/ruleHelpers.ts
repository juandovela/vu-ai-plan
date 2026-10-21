/**
 * ruleHelpers.ts
 *
 * Small helpers shared by the rule files.
 *
 * @package plan-vu-ui/src/ai/logicAssist
 */

import { includes } from './util';

import type { IFLogicAssistItem } from './types';

export const displayName = (item: IFLogicAssistItem) =>
  item.originalName ?? item.name;

export const sharesLogicGroup = (items: IFLogicAssistItem[]) =>
  items[0].logic.some(group => items.every(item => includes(item.logic, group)));

/**
 * Letters and numbers only. Used to compare room names and locations.
 */
export const normalizeKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Name without the words that only say "this is the optional/standard
 * version", and with the words sorted, so both versions of the same thing
 * share one key ("Interior Corner Fireplace" / "Interior Fireplace Corner").
 */
export const baseKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(opt|optional|standard)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .sort()
    .join(' ');

/**
 * Where an option is, from names like "Door at Den" or
 * "Bedroom 5 with Bath 3 at Den and Powder" => ['den', 'powder'].
 */
export function locationsOf(name: string): string[] {
  const parts = name.split(/\s+at\s+/i);

  if (parts.length < 2) {
    return [];
  }

  return parts[parts.length - 1]
    .split(/\s+and\s+|\s*,\s*|\s*\/\s*/i)
    .map(normalizeKey)
    .filter(location => location.length > 0);
}

const hasWord = (name: string, word: string) =>
  new RegExp(`\\b${word}\\b`, 'i').test(name);

/**
 * Upper / Lower Cabinets sit on top of each other but go together, so they
 * are not alternatives. The team merges them into one option, so
 * "Upper and Lower Cabinets" against "Lower Cabinets" counts as well.
 */
export function areComplements(a: IFLogicAssistItem, b: IFLogicAssistItem) {
  const nameA = displayName(a);
  const nameB = displayName(b);
  const strip = (name: string) =>
    baseKey(name.replace(/\b(upper|lower|and)\b/gi, ' '));
  const hasSide = (name: string) => hasWord(name, 'upper') || hasWord(name, 'lower');

  return (
    nameA !== nameB &&
    hasSide(nameA) &&
    hasSide(nameB) &&
    strip(nameA) === strip(nameB)
  );
}

/**
 * Words that say what an option is, without the location or the filler.
 * "Center Sliding Glass Door at Gathering Room" => center, sliding, glass, door
 */
const FILLER = [
  'a', 'an', 'the', 'of', 'in', 'to', 'for', 'with', 'and', 'at', 'opt',
  'optional', 'standard', 'def', 'default', 'lieu', 'ilo', 'w'
];

export function headTokens(name: string): string[] {
  return name
    .split(/\s+at\s+/i)[0]
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map(token => token.replace(/'/g, ''))
    .filter(token => token.length > 1 && !includes(FILLER, token));
}

/**
 * Things an option adds, from names like "Bedroom 6 & Bath 4" or
 * "Bedroom 5 with Bath 3 at Den and Powder" => ['bedroom6', 'bath4'].
 */
export function featuresOf(name: string): string[] {
  return name
    .split(/\s+at\s+/i)[0]
    .replace(/^\s*(opt|optional)\s+/i, '')
    .split(/\s+with\s+|\s+and\s+|\s*&\s*/i)
    .map(normalizeKey)
    .filter(feature => feature.length > 0);
}
