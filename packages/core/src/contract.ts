/**
 * The contract between the plan app and the backend.
 *
 * Everything that crosses the wire is described here, once, with zod. The
 * TypeScript types and the JSON Schemas in /contract come from these schemas,
 * so they can not drift apart.
 *
 * Change rules: adding an optional field is compatible. Anything else (rename,
 * remove, new required field, new operation kind) needs a new CONTRACT_VERSION.
 */

import { z } from 'zod';

export const CONTRACT_VERSION = 1 as const;

/* -------------------------------------------------------------------------- */
/* Operations: the tools an analysis can propose                              */
/* -------------------------------------------------------------------------- */

export const confidenceSchema = z.enum(['high', 'medium', 'low']);
export const sourceSchema = z.enum(['rules', 'ai', 'pdf']);

/**
 * Filters of the Logic panel. "none" is accepted when reading a plan but is
 * never proposed.
 */
export const FILTERS = [
  'none',
  'hide',
  'studio',
  'studio-only',
  'elevation',
  'default',
  'unlisted',
  'preselected',
  'not-available'
] as const;
export const filterSchema = z.enum(FILTERS);

const operationBase = {
  /** Stable id, the same proposal always gets the same id. */
  id: z.string().min(1),
  reason: z.string(),
  confidence: confidenceSchema,
  source: sourceSchema
};

export const operationSchema = z.discriminatedUnion('kind', [
  z.object({
    ...operationBase,
    kind: z.literal('rename'),
    listItemUid: z.string(),
    from: z.string(),
    to: z.string().min(1)
  }),
  z.object({
    ...operationBase,
    kind: z.literal('filter'),
    listItemUid: z.string(),
    filter: filterSchema
  }),
  z.object({
    ...operationBase,
    kind: z.literal('logicGroup'),
    /** Options that exclude each other: only one can be on. */
    listItemUids: z.array(z.string()).min(2)
  }),
  z.object({
    ...operationBase,
    kind: z.literal('package'),
    /** Options that turn on and off together. */
    listItemUids: z.tuple([z.string(), z.string()])
  }),
  z.object({
    ...operationBase,
    kind: z.literal('nest'),
    /** The child is only available while the parent is on. */
    childUid: z.string(),
    parentUid: z.string()
  }),
  z.object({
    ...operationBase,
    kind: z.literal('floor'),
    /** Turning the option on makes that floor available. */
    listItemUid: z.string(),
    floorUid: z.string()
  }),
  z.object({
    ...operationBase,
    kind: z.literal('elevationPackage'),
    /** The elevation image switches these options on (and back). */
    elevationUid: z.string(),
    listItemUids: z.array(z.string()).min(1)
  })
]);

export const OPERATION_KINDS = [
  'rename',
  'filter',
  'logicGroup',
  'package',
  'nest',
  'floor',
  'elevationPackage'
] as const;

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number()
});

/**
 * One list item of the plan, as the Logic panel shows it.
 */
export const itemSchema = z.object({
  uid: z.string(),
  /** "structure" items are rooms and default versions that come with the plan. */
  kind: z.enum(['option', 'structure']),
  name: z.string(),
  /** Name decoded from the svg id, when it carries one. */
  originalName: z.string().nullable(),
  floor: z.string().nullable(),
  floorUid: z.string().nullable(),
  filter: z.array(z.string()),
  logic: z.array(z.number()),
  parent: z.array(z.string()),
  package: z.array(z.string()),
  /** Footprint of the option drawing, null when the plan has none per option. */
  rect: rectSchema.nullable(),
  /** Room names the option draws, multi line labels already joined. */
  labels: z.array(z.string())
});

export const floorSchema = z.object({
  uid: z.string(),
  name: z.string(),
  /** 1 = first floor. */
  floorNumber: z.number()
});

export const elevationSchema = z.object({
  uid: z.string(),
  name: z.string(),
  /** Uids of the options this elevation switches on. */
  package: z.array(z.string())
});

/* -------------------------------------------------------------------------- */
/* The plan sheet (the builder's PDF, already read)                            */
/* -------------------------------------------------------------------------- */

export const sheetOptionSchema = z.object({
  /** 1 = first floor, 0 = basement. */
  floorNumber: z.number().int().nullable(),
  /** From the options table, ex. "Den and Powder". */
  location: z.string(),
  /** From the options table, ex. "Bedroom 5 with Bath 3". */
  name: z.string(),
  /** Title under the option's own drawing. */
  caption: z.string().nullable().default(null),
  /** Options drawn together in one inset share the key. */
  insetKey: z.string().nullable().default(null),
  /** Rooms of the base plan that stop existing with this option. */
  replaces: z.array(z.string()).default([]),
  /** Rooms this option creates. */
  adds: z.array(z.string()).default([]),
  /** Footnote marker next to the option, ex. "*", "**". */
  marker: z.string().nullable().default(null)
});

export const planSheetSchema = z.object({
  planName: z.string().nullable().default(null),
  specs: z
    .object({
      sqft: z.string().nullable().default(null),
      bedrooms: z.string().nullable().default(null),
      baths: z.string().nullable().default(null)
    })
    .default({ sqft: null, bedrooms: null, baths: null }),
  /** Captions of the front renderings, ex. "Elevation B". */
  elevations: z.array(z.string()).default([]),
  /** Footnotes, ex. "**" = "Option not available on every homesite". */
  notes: z.array(z.object({ marker: z.string(), text: z.string() })).default([]),
  options: z.array(sheetOptionSchema)
});

/* -------------------------------------------------------------------------- */
/* Analysis                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything the analysis needs, and nothing else: no urls, no images, no
 * user data. Built by the app from the plan being configured.
 */
export const snapshotSchema = z.object({
  floors: z.array(floorSchema),
  items: z.array(itemSchema),
  elevations: z.array(elevationSchema),
  /** Normalised (letters and numbers only) room names each floor draws. */
  floorLabels: z.record(z.string(), z.array(z.string())),
  sheet: planSheetSchema.nullable().default(null),
  /** Abbreviations used in names, ex. { ilo: "in lieu of" }. */
  glossary: z.record(z.string(), z.string()).default({})
});

export const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(['warning', 'info']),
  message: z.string()
});

export const analyzeRequestSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  snapshot: snapshotSchema,
  /** What the user asked for, free text. */
  prompt: z.string().max(1000).default('')
});

/** One step of what the backend did, to show or debug an analysis. */
export const traceStepSchema = z.object({
  tool: z.string(),
  input: z.unknown(),
  ok: z.boolean(),
  summary: z.string()
});

export const analyzeResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  operations: z.array(operationSchema),
  findings: z.array(findingSchema),
  assistantText: z.string(),
  trace: z.array(traceStepSchema).default([])
});

export const sheetResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  sheet: planSheetSchema
});

export const errorResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  error: z.object({
    code: z.enum([
      'bad_request',
      'unauthorized',
      'forbidden',
      'payload_too_large',
      'unsupported_contract_version',
      'upstream_failed',
      'internal'
    ]),
    message: z.string()
  })
});

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type Operation = z.infer<typeof operationSchema>;
export type OperationKind = (typeof OPERATION_KINDS)[number];
export type Confidence = z.infer<typeof confidenceSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Filter = z.infer<typeof filterSchema>;
export type PlanItem = z.infer<typeof itemSchema>;
export type PlanFloor = z.infer<typeof floorSchema>;
export type PlanElevation = z.infer<typeof elevationSchema>;
export type PlanRect = z.infer<typeof rectSchema>;
export type PlanSheet = z.infer<typeof planSheetSchema>;
export type SheetOption = z.infer<typeof sheetOptionSchema>;
export type PlanSnapshot = z.infer<typeof snapshotSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type TraceStep = z.infer<typeof traceStepSchema>;
export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;
export type AnalyzeResponse = z.infer<typeof analyzeResponseSchema>;
export type SheetResponse = z.infer<typeof sheetResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
