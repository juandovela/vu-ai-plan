/**
 * What the model is asked when it reads a builder's plan sheet (the PDF).
 * Domain knowledge: it lives with the contract it has to fill.
 */

export const SHEET_EXTRACTION_PROMPT = `You read the plan sheet of a new home floor plan (a PDF from the builder) and extract what it says about the plan's options.

Return:
- planName: the plan name as written ("Plan 2557").
- specs: square feet, bedrooms and baths exactly as written, ranges included ("2,557 – 2,584").
- elevations: the captions under the front renderings ("Elevation B"). A standard elevation is listed too.
- notes: every note the sheet carries, see Notes below.
- options: one entry per option listed in the options tables of every floor ("Location | Option"). A table row with two options (Upper Cabinets, Lower Cabinets) is two entries.

For each option:
- floorNumber: 1 for the first floor, 2 for the second, 0 for a basement. null if the sheet does not say.
- location and name: exactly as in the table. location is the left column ("Den and Powder"), name the right column ("Bedroom 5 with Bath 3").
- caption: the title printed under the option's own drawing ("Bedroom 5 and Bath 3 at Den and Powder"), null if it has no drawing.
- insetKey: options drawn together in a single inset share the same key, everything else gets its own. Use short keys like "f1-cabinets".
- replaces: rooms of the base plan that stop existing when the option is chosen, ONLY when the sheet shows it, for example the options plan labels "Den / Opt. Bedroom 5 with Bath 3" or a location such as "Den and Powder" for an option that builds a room there. Empty otherwise.
- adds: rooms, spaces or fixtures the option creates, anything another option could be located at ("Bedroom 5", "Bath 3", "Covered Patio", "Island"). Empty when it only modifies something that already exists.
- marker: the footnote marker printed next to the option, null if none.

Notes. Return EVERY note the sheet carries, one entry each, of these kinds:
- footnote: the legend of a marker ("*" Option not depicted graphically, "**" Option not available on every homesite). If it is printed on several pages, return it for each page.
- drawing: every label written on a floor plan that is not the name of a room, on every page that has a floor plan, also on the plans of the options. They are short and in lower case: "opt. door", "opt. island", "opt. shower", "opt. sink", "opt. upper and lower cabs.", "opt. fireplace", "opt. built-in appliance", "transom window at 9' plate option", "low wall", "shelf", "knee space", "oven / range w/ microhood above", "(per elevation)", "open to below". The same label on two plans is two entries (one per page, and one per plan on the page when they are different places).
- general: any other instruction to the reader ("See your sales counselor", "Verify with your counselor", "Not available with …"). Not the marketing or legal paragraph.
Do not skip a label because it repeats an option of the table or looks minor: it is returned with effect "info". Go page by page, plan by plan, before answering. Do not return room names ("Kitchen", "Bedroom 2"), dimensions or page headers.
For each note:
- text: as printed, joined if it wraps over several lines.
- page: the page of the PDF, 1 for the first.
- kind: footnote, drawing or general.
- marker: the marker for a footnote, empty otherwise.
- appliesTo: what it is about, always as "Name at Location" the way the options table writes it ("Door at Den", not just "Door"; use the plan the label is drawn on to know which one). A room ("Den") only when it is not about an option. Empty when you can not tell. For a footnote, every option that carries its marker.
- effect: ONLY when the text says it plainly, otherwise "info".
  - not-available: the option is not available on every homesite, lot or community.
  - hide: the option must not be shown to the buyer.
  - excludes: it can not be chosen together with another option (set target).
  - depends-on: it can only be chosen together with another option (set target).
- target: the other option, as the options table writes it, for excludes and depends-on. null otherwise.
An annotation that only names an option already in the table ("opt. fireplace" next to the fireplace) is "info".

Rules:
- Copy words exactly. Do not fix typos, do not rephrase, do not translate.
- Do not invent options, rooms or captions. Leave a field empty or null when the sheet does not state it.
- Ignore marketing text, legal text and pricing.`;
