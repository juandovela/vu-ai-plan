/**
 * The model's reading of a plan sheet is untrusted: coerce it into the shape
 * the contract promises and drop what is not usable.
 */

import { NOTE_EFFECTS, planSheetSchema, type NoteEffect, type PlanSheet } from '../contract';

const MAX_OPTIONS = 200;
const MAX_NOTES = 120;

const clean = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const orNull = (value: unknown): string | null => clean(value) || null;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(clean).filter(item => item.length > 0) : [];

export function normalizePlanSheet(raw: unknown): PlanSheet {
  if (!raw || typeof raw !== 'object') {
    throw new Error('The model did not return a plan sheet.');
  }

  const sheet = raw as Record<string, any>;

  const options = (Array.isArray(sheet.options) ? sheet.options : [])
    .slice(0, MAX_OPTIONS)
    .map((option: any) => ({
      floorNumber:
        typeof option?.floorNumber === 'number' && Number.isFinite(option.floorNumber)
          ? Math.round(option.floorNumber)
          : null,
      location: clean(option?.location),
      name: clean(option?.name),
      caption: orNull(option?.caption),
      insetKey: orNull(option?.insetKey),
      replaces: strings(option?.replaces),
      adds: strings(option?.adds),
      marker: orNull(option?.marker)
    }))
    .filter((option: { name: string }) => option.name.length > 0);

  return planSheetSchema.parse({
    planName: orNull(sheet.planName),
    specs: {
      sqft: orNull(sheet.specs?.sqft),
      bedrooms: orNull(sheet.specs?.bedrooms),
      baths: orNull(sheet.specs?.baths)
    },
    elevations: strings(sheet.elevations),
    notes: (Array.isArray(sheet.notes) ? sheet.notes : [])
      .slice(0, MAX_NOTES)
      .map((note: any) => {
        const marker = clean(note?.marker);
        const appliesTo = strings(note?.appliesTo);
        const target = orNull(note?.target);
        const asked: NoteEffect = NOTE_EFFECTS.includes(note?.effect) ? note.effect : 'info';
        const needsTarget = asked === 'excludes' || asked === 'depends-on';

        return {
          marker,
          text: clean(note?.text),
          page: typeof note?.page === 'number' && Number.isFinite(note.page) ? Math.max(1, Math.round(note.page)) : null,
          kind: ['footnote', 'drawing', 'general'].includes(note?.kind) ? note.kind : marker ? 'footnote' : 'general',
          appliesTo,
          // an action needs something to act on: without it the note is only information
          effect: appliesTo.length === 0 || (needsTarget && !target) ? ('info' as NoteEffect) : asked,
          target
        };
      })
      .filter((note: { text: string }) => note.text.length > 0),
    options
  });
}
