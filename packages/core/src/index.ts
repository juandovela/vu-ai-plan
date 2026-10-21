export * from './contract';
export { contractJsonSchemas } from './jsonSchema';
export { analyzeDeterministic } from './analyze';
export { explainInvalid } from './validate';

export { snapshotFromBasegroup, findAssetInAssets } from './adapters/basegroup';
export type { BasegroupFloor } from './adapters/basegroup';

export { buildRuleSuggestions, DEFAULT_GLOSSARY } from './rules/ruleSuggestions';
export { buildSheetSuggestions } from './rules/sheetRules';
export { mergeLabels } from './rules/labels';
export { decodeTargetId } from './rules/decodeTargetId';

export { VirtualPlan } from './tools/virtualPlan';
export type { ProposeResult } from './tools/virtualPlan';
export { TOOLS, executeTool, toolDefinitions } from './tools/tools';
export type { ToolDef, ToolOutcome } from './tools/tools';

export { normalizePlanSheet } from './sheet/normalize';
export { SHEET_EXTRACTION_PROMPT } from './sheet/prompt';

export { runAgent } from './agent/runAgent';
export type { AgentOptions, AgentResult } from './agent/runAgent';
export { AGENT_SYSTEM_PROMPT, buildKickoff } from './agent/prompt';
export type {
  ModelClient,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ToolCall,
  ToolDeclaration,
  ToolResult
} from './agent/types';
