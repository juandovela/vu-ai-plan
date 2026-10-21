/**
 * The few lodash helpers the rules used, native.
 */

export function includes<T>(list: readonly T[] | undefined | null, value: T): boolean {
  return !!list && list.indexOf(value) !== -1;
}

export function groupBy<T>(
  list: readonly T[],
  key: (item: T) => string
): { [group: string]: T[] } {
  const groups: { [group: string]: T[] } = {};

  list.forEach(item => {
    const name = key(item);

    (groups[name] = groups[name] || []).push(item);
  });

  return groups;
}
