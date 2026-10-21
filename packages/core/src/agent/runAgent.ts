/**
 * Runs the agent: the deterministic baseline first, then a model that calls
 * tools on a copy of the plan until it has nothing more to propose.
 *
 * It never throws because of the model. If the model fails, what the rules
 * found is still the answer, with a warning.
 */

import { analyzeDeterministic } from '../analyze';
import type { Finding, Operation, PlanSnapshot, TraceStep } from '../contract';
import { executeTool, toolDefinitions } from '../tools/tools';
import { VirtualPlan } from '../tools/virtualPlan';
import { AGENT_SYSTEM_PROMPT, buildKickoff } from './prompt';
import type { ModelClient, ModelMessage } from './types';

export interface AgentOptions {
  snapshot: PlanSnapshot;
  prompt?: string;
  model: ModelClient;
  /** Calls to the model. */
  maxSteps?: number;
  /** Tool calls in total. */
  maxToolCalls?: number;
}

export interface AgentResult {
  operations: Operation[];
  findings: Finding[];
  assistantText: string;
  trace: TraceStep[];
  /** How many times the model was called. */
  steps: number;
}

export async function runAgent({
  snapshot,
  prompt = '',
  model,
  maxSteps = 12,
  maxToolCalls = 60
}: AgentOptions): Promise<AgentResult> {
  const baseline = analyzeDeterministic(snapshot);
  const plan = new VirtualPlan(snapshot, baseline.operations);
  const tools = toolDefinitions();
  const trace: TraceStep[] = [];
  const findings: Finding[] = baseline.findings.slice();
  const messages: ModelMessage[] = [{ role: 'user', text: buildKickoff(snapshot, prompt, baseline) }];

  let assistantText = '';
  let steps = 0;
  let toolCalls = 0;
  let finished = false;

  try {
    while (steps < maxSteps && toolCalls < maxToolCalls) {
      steps++;

      const response = await model.generate({ system: AGENT_SYSTEM_PROMPT, messages, tools });

      messages.push({ role: 'model', text: response.text, toolCalls: response.toolCalls, raw: response.raw });

      if (response.toolCalls.length === 0) {
        assistantText = response.text.trim();
        finished = true;
        break;
      }

      const results = response.toolCalls.map(call => {
        toolCalls++;

        const outcome = executeTool(plan, call.name, call.args);

        trace.push({ tool: call.name, input: call.args, ok: outcome.ok, summary: outcome.summary });

        return {
          name: call.name,
          output: outcome.ok ? (outcome.result ?? { ok: true }) : { error: outcome.error }
        };
      });

      messages.push({ role: 'user', toolResults: results });
    }

    if (!finished) {
      findings.push({
        id: 'ai-budget',
        severity: 'info',
        message: `The AI stopped after ${steps} step(s) and ${toolCalls} tool call(s) without finishing. What it proposed so far is included.`
      });
    }
  } catch (error) {
    findings.push({
      id: 'ai-failed',
      severity: 'warning',
      message: `The AI step failed (${error instanceof Error ? error.message : 'unknown error'}). Only the rules and the plan sheet were used${
        plan.proposed().length > 0 ? ', plus what the AI proposed before failing' : ''
      }.`
    });
  }

  const proposed = plan.proposed();

  return {
    operations: baseline.operations.concat(proposed),
    findings,
    assistantText:
      assistantText ||
      (proposed.length > 0 ? `The AI proposed ${proposed.length} change(s) on top of the rules.` : ''),
    trace,
    steps
  };
}
