/**
 * The tools an agent can call. They run on a VirtualPlan, so nothing here
 * changes the real plan: proposals come back as operations.
 *
 * Read tools look at the plan. Propose tools record an operation if it is
 * valid and new, and say why when it is not.
 */

import { z } from 'zod';

import { confidenceSchema, filterSchema, type Operation, type PlanItem } from '../contract';
import { VirtualPlan } from './virtualPlan';

export interface ToolDef {
  name: string;
  description: string;
  /** Read tools never change what will be proposed. */
  readOnly: boolean;
  input: z.ZodType;
  run: (plan: VirtualPlan, input: any) => unknown;
}

export interface ToolOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** One line for the trace. */
  summary: string;
}

const compact = (item: PlanItem) => ({
  uid: item.uid,
  kind: item.kind,
  name: item.name,
  nameFromLayer: item.originalName ?? undefined,
  floor: item.floor,
  floorUid: item.floorUid,
  filter: item.filter,
  logic: item.logic,
  parent: item.parent,
  package: item.package,
  labels: item.labels
});

const summarise = (op: Operation) => ({
  id: op.id,
  kind: op.kind,
  confidence: op.confidence,
  source: op.source,
  reason: op.reason
});

const why = {
  reason: z.string().min(3).max(240).describe('One short sentence: why.'),
  confidence: confidenceSchema.describe(
    '"high" only when the names or the plan sheet state it directly. "low" when it is a guess.'
  )
};

const uid = (description: string) => z.string().describe(description);

/**
 * Proposals are always attributed to the AI, with the plan's own item order
 * so the id of a proposal is stable.
 */
const base = (input: { reason: string; confidence: Operation['confidence'] }) => ({
  reason: input.reason,
  confidence: input.confidence,
  source: 'ai' as const
});

export const TOOLS: ToolDef[] = [
  /* ------------------------------ read ------------------------------ */
  {
    name: 'list_floors',
    description: 'The floors of the plan.',
    readOnly: true,
    input: z.object({}),
    run: plan => plan.snapshot.floors
  },
  {
    name: 'list_items',
    description:
      'The options and structure items of the plan with their current filters, logic groups, parents and links. Structure items are rooms and default versions that come with the plan.',
    readOnly: true,
    input: z.object({
      floorUid: z.string().optional().describe('Only the items of this floor.'),
      kind: z.enum(['option', 'structure']).optional()
    }),
    run: (plan, input: { floorUid?: string; kind?: 'option' | 'structure' }) =>
      plan
        .items()
        .filter(item => (!input.floorUid || item.floorUid === input.floorUid) && (!input.kind || item.kind === input.kind))
        .map(compact)
  },
  {
    name: 'get_item',
    description: 'One item of the plan.',
    readOnly: true,
    input: z.object({ uid: uid('Item uid.') }),
    run: (plan, input: { uid: string }) => {
      const item = plan.item(input.uid);

      if (!item) throw new Error(`Unknown item "${input.uid}".`);
      return { ...compact(item), rect: item.rect };
    }
  },
  {
    name: 'get_floor_labels',
    description: 'The room names a floor draws (letters and numbers only, lower case).',
    readOnly: true,
    input: z.object({ floorUid: uid('Floor uid.') }),
    run: (plan, input: { floorUid: string }) => plan.snapshot.floorLabels[input.floorUid] ?? []
  },
  {
    name: 'get_sheet',
    description:
      "The builder's plan sheet (PDF) already read: options by location, captions, rooms each option replaces or adds, footnotes. null when there is none.",
    readOnly: true,
    input: z.object({}),
    run: plan => plan.snapshot.sheet
  },
  {
    name: 'get_baseline',
    description:
      'What the rules and the plan sheet already proposed. Do not propose these again.',
    readOnly: true,
    input: z.object({}),
    run: plan => plan.baselineOperations().map(summarise)
  },
  {
    name: 'get_proposals',
    description: 'What has been proposed so far in this analysis.',
    readOnly: true,
    input: z.object({}),
    run: plan => plan.proposed().map(summarise)
  },

  /* ----------------------------- propose ---------------------------- */
  {
    name: 'propose_rename',
    description: 'Rename an option: fix a typo or restore punctuation. Keep the builder wording otherwise.',
    readOnly: false,
    input: z.object({ uid: uid('Option uid.'), to: z.string().min(1).describe('New name.'), ...why }),
    run: (plan, input) =>
      plan.propose({
        ...base(input),
        id: `rename:${input.uid}`,
        kind: 'rename',
        listItemUid: input.uid,
        from: plan.item(input.uid)?.name ?? '',
        to: input.to.trim()
      })
  },
  {
    name: 'propose_filter',
    description:
      'Set a filter on an item. default = standard version, on and unlisted. elevation = exterior elevation option. hide = hidden everywhere. preselected = on when the plan loads. not-available = warns when clicked.',
    readOnly: false,
    input: z.object({ uid: uid('Item uid.'), filter: filterSchema.exclude(['none']), ...why }),
    run: (plan, input) =>
      plan.propose({
        ...base(input),
        id: `filter:${input.uid}:${input.filter}`,
        kind: 'filter',
        listItemUid: input.uid,
        filter: input.filter
      })
  },
  {
    name: 'propose_exclusive_group',
    description:
      'Items that exclude each other: only one can be on. Use it for alternatives of the same thing in the same place, and for a default version against the option that replaces it.',
    readOnly: false,
    input: z.object({ uids: z.array(z.string()).min(2).describe('Two or more item uids.'), ...why }),
    run: (plan, input: { uids: string[]; reason: string; confidence: Operation['confidence'] }) => {
      const uids = plan.order(input.uids);

      return plan.propose({ ...base(input), id: `logicGroup:${uids.join('+')}`, kind: 'logicGroup', listItemUids: uids });
    }
  },
  {
    name: 'propose_package',
    description: 'Two items that turn on and off together.',
    readOnly: false,
    input: z.object({ uids: z.tuple([z.string(), z.string()]).describe('Exactly two item uids.'), ...why }),
    run: (plan, input: { uids: [string, string]; reason: string; confidence: Operation['confidence'] }) => {
      const uids = plan.order(input.uids);
      const pair: [string, string] = [uids[0] ?? input.uids[0], uids[1] ?? input.uids[1]];

      return plan.propose({ ...base(input), id: `package:${pair.join('+')}`, kind: 'package', listItemUids: pair });
    }
  },
  {
    name: 'propose_nest',
    description: 'The child item is only available while the parent item is on.',
    readOnly: false,
    input: z.object({ childUid: uid('Dependent item uid.'), parentUid: uid('Item it depends on.'), ...why }),
    run: (plan, input) =>
      plan.propose({
        ...base(input),
        id: `nest:${input.childUid}:${input.parentUid}`,
        kind: 'nest',
        childUid: input.childUid,
        parentUid: input.parentUid
      })
  },
  {
    name: 'propose_floor_link',
    description: 'Turning the option on makes a floor available (ex. an option that adds a basement).',
    readOnly: false,
    input: z.object({ uid: uid('Option uid.'), floorUid: uid('Floor uid.'), ...why }),
    run: (plan, input) =>
      plan.propose({
        ...base(input),
        id: `floor:${input.uid}:${input.floorUid}`,
        kind: 'floor',
        listItemUid: input.uid,
        floorUid: input.floorUid
      })
  },
  {
    name: 'propose_elevation_package',
    description: 'The elevation image switches these options on, and turning one on switches the elevation.',
    readOnly: false,
    input: z.object({
      elevationUid: uid('Elevation uid.'),
      uids: z.array(z.string()).min(1).describe('Option uids, including the ones it already has.'),
      ...why
    }),
    run: (plan, input: { elevationUid: string; uids: string[]; reason: string; confidence: Operation['confidence'] }) =>
      plan.propose({
        ...base(input),
        id: `elevationPackage:${input.elevationUid}`,
        kind: 'elevationPackage',
        elevationUid: input.elevationUid,
        listItemUids: input.uids
      })
  }
];

/**
 * Runs a tool. It never throws: a bad call comes back as an error the caller
 * can read and correct.
 */
export function executeTool(plan: VirtualPlan, name: string, rawInput: unknown): ToolOutcome {
  const tool = TOOLS.find(candidate => candidate.name === name);

  if (!tool) {
    return { ok: false, error: `Unknown tool "${name}".`, summary: `unknown tool ${name}` };
  }

  const parsed = tool.input.safeParse(rawInput ?? {});

  if (!parsed.success) {
    const error = parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');

    return { ok: false, error, summary: `invalid input: ${error}` };
  }

  try {
    const result = tool.run(plan, parsed.data) as { ok?: boolean; id?: string; error?: string } | unknown;

    if (!tool.readOnly) {
      const outcome = result as { ok: boolean; id?: string; error?: string };

      return outcome.ok
        ? { ok: true, result: { id: outcome.id }, summary: `proposed ${outcome.id}` }
        : { ok: false, error: outcome.error, summary: outcome.error ?? 'rejected' };
    }

    return { ok: true, result, summary: 'ok' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The tool failed.';

    return { ok: false, error: message, summary: message };
  }
}

/**
 * The tools as function declarations for a model, provider independent.
 */
export function toolDefinitions(): Array<{ name: string; description: string; parameters: unknown }> {
  return TOOLS.map(tool => {
    const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.input, {
      target: 'draft-2020-12',
      io: 'input'
    }) as Record<string, unknown>;

    return { name: tool.name, description: tool.description, parameters };
  });
}
