/**
 * decodeTargetId.ts
 *
 * Illustrator exports layer names as svg ids, encoding special characters
 * as _xNN_ (ex. @ = _x40_). The list item name is built from that id and
 * loses them, so the id is the best source for the original name.
 *
 *   opt5-Opt_Drop-in_Tub__x40__Owner_x27_s_Bath
 *   => Opt Drop-in Tub @ Owner's Bath
 *
 * @package plan-vu-ui/src/ai/logicAssist
 */

export function decodeTargetId(targetID?: string | null): string | null {
  if (!targetID) {
    return null;
  }

  /**
   * Only ids shaped like "opt5-Name_Of_Option" carry a name. Ids from other
   * sources ("o13_opt", "s21_std") are codes, not names.
   */
  if (!/^[a-z]+\d+-./i.test(targetID)) {
    return null;
  }

  const withoutPrefix = targetID.replace(/^[a-z]+\d+-/i, '');

  const decoded = withoutPrefix
    .replace(/_x([0-9a-f]{2})_/gi, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return decoded.length > 0 ? decoded : null;
}
