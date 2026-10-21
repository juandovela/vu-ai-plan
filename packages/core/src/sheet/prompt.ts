/**
 * What the model is asked when it reads a builder's plan sheet (the PDF).
 * Domain knowledge: it lives with the contract it has to fill.
 */

export const SHEET_EXTRACTION_PROMPT = `You read the plan sheet of a new home floor plan (a PDF from the builder) and extract what it says about the plan's options.

Return:
- planName: the plan name as written ("Plan 2557").
- specs: square feet, bedrooms and baths exactly as written, ranges included ("2,557 – 2,584").
- elevations: the captions under the front renderings ("Elevation B"). A standard elevation is listed too.
- notes: footnotes with their marker ("*" or "**") and their text.
- options: one entry per option listed in the options tables of every floor ("Location | Option"). A table row with two options (Upper Cabinets, Lower Cabinets) is two entries.

For each option:
- floorNumber: 1 for the first floor, 2 for the second, 0 for a basement. null if the sheet does not say.
- location and name: exactly as in the table. location is the left column ("Den and Powder"), name the right column ("Bedroom 5 with Bath 3").
- caption: the title printed under the option's own drawing ("Bedroom 5 and Bath 3 at Den and Powder"), null if it has no drawing.
- insetKey: options drawn together in a single inset share the same key, everything else gets its own. Use short keys like "f1-cabinets".
- replaces: rooms of the base plan that stop existing when the option is chosen, ONLY when the sheet shows it, for example the options plan labels "Den / Opt. Bedroom 5 with Bath 3" or a location such as "Den and Powder" for an option that builds a room there. Empty otherwise.
- adds: rooms, spaces or fixtures the option creates, anything another option could be located at ("Bedroom 5", "Bath 3", "Covered Patio", "Island"). Empty when it only modifies something that already exists.
- marker: the footnote marker printed next to the option, null if none.

Rules:
- Copy words exactly. Do not fix typos, do not rephrase, do not translate.
- Do not invent options, rooms or captions. Leave a field empty or null when the sheet does not state it.
- Ignore marketing text, legal text and pricing.`;
