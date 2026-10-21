/**
 * The analysis that needs no model: what the plan sheet says, then the rules.
 * It is the baseline an agent starts from, and what the app shows instantly.
 */

import type { Finding, Operation, PlanSnapshot } from './contract';
import { buildRuleSuggestions } from './rules/ruleSuggestions';
import { buildSheetSuggestions } from './rules/sheetRules';
import type { IFRuleContext } from './rules/types';

export function analyzeDeterministic(snapshot: PlanSnapshot): {
  operations: Operation[];
  findings: Finding[];
} {
  const context: IFRuleContext = {
    floorLabels: snapshot.floorLabels,
    elevations: snapshot.elevations
  };

  const ruleOps = buildRuleSuggestions(snapshot.items, context);
  const sheet = snapshot.sheet
    ? buildSheetSuggestions(snapshot.items, snapshot.floors, snapshot.sheet)
    : { ops: [] as Operation[], findings: [] as Finding[] };

  /**
   * What the sheet says comes first. It replaces a rename guessed from the
   * layer name, and wins when the rules found the same thing.
   */
  const renamedBySheet = sheet.ops
    .filter(op => op.kind === 'rename')
    .map(op => (op as { listItemUid: string }).listItemUid);

  const rules = ruleOps.filter(
    op => !(op.kind === 'rename' && renamedBySheet.indexOf(op.listItemUid) !== -1)
  );

  return {
    operations: sheet.ops.concat(rules.filter(rule => !sheet.ops.some(op => op.id === rule.id))),
    findings: sheet.findings
  };
}
