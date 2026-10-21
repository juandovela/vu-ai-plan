/**
 * labels.ts
 *
 * Illustrator exports every line of a multi line label as its own text
 * frame, in any order ("oven /", "range w/", "micro-", "hood", "above").
 * This joins them back using their position.
 *
 * @package plan-vu-ui/src/ai/logicAssist
 */

export interface IFLabelLike {
  name: string;
  x: number;
  y: number;
  width?: number;
  fontSize: number | string;
}

export function mergeLabels(labels?: IFLabelLike[] | null): string[] {
  if (!labels || labels.length === 0) {
    return [];
  }

  const items = labels
    .map(label => ({
      text: String(label.name ?? '').trim(),
      center: label.x + (label.width ?? 0) / 2,
      width: label.width ?? 0,
      y: label.y,
      size: Number(label.fontSize) || 4
    }))
    .filter(item => item.text.length > 0)
    .sort((a, b) => a.y - b.y);

  const used = items.map(() => false);
  const merged: string[] = [];

  items.forEach((item, index) => {
    if (used[index]) {
      return;
    }

    used[index] = true;

    let text = item.text;
    let last = item;

    for (let next = index + 1; next < items.length; next++) {
      const candidate = items[next];
      const gap = candidate.y - last.y;

      /**
       * Sorted from top to bottom, so once a line is too far every
       * following line is too far as well.
       */
      if (gap > last.size * 1.8) {
        break;
      }

      const sameLine = gap < last.size * 0.5;
      const sameSize = candidate.size === last.size;
      const sameColumn =
        Math.abs(candidate.center - last.center) <=
        Math.max(candidate.width, last.width) / 2 + 1;

      if (used[next] || sameLine || !sameSize || !sameColumn) {
        continue;
      }

      used[next] = true;
      text += (text.slice(-1) === '-' ? '' : ' ') + candidate.text;
      last = candidate;
    }

    merged.push(text);
  });

  return merged;
}
