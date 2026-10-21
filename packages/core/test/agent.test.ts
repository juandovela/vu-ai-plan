import { describe, expect, it } from 'vitest';

import { AGENT_SYSTEM_PROMPT, analyzeDeterministic, runAgent, TOOLS, type ModelClient, type ModelRequest, type ModelResponse } from '../src';
import { uidOf, woodberry, woodberrySheet } from './helpers';

/** A model that answers from a script, and remembers what it was asked. */
function scripted(steps: Array<(request: ModelRequest) => ModelResponse>): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];

  return {
    requests,
    async generate(request) {
      requests.push(structuredClone(request));
      const step = steps[requests.length - 1];

      if (!step) throw new Error('the script ran out');

      return step(request);
    }
  };
}

const call = (name: string, args: unknown) => ({ name, args });
const answer = (text: string): ModelResponse => ({ text, toolCalls: [] });
const calling = (...calls: Array<{ name: string; args: unknown }>): ModelResponse => ({ text: '', toolCalls: calls });

const snapshot = () => ({ ...woodberry(), sheet: woodberrySheet() });

describe('agent', () => {
  it('starts from the rules, adds what the model proposes, and keeps the trace', async () => {
    const plan = snapshot();
    const island = uidOf(plan, 'Optional Island at Kitchen');
    const door = uidOf(plan, 'Optional Door at Primary Bath');
    const baseline = analyzeDeterministic(plan).operations;

    const model = scripted([
      () => calling(call('get_baseline', {}), call('list_floors', {})),
      () => calling(call('propose_exclusive_group', { uids: [island, door], reason: 'Test group.', confidence: 'low' })),
      () => answer('Added one group, check the island.')
    ]);

    const result = await runAgent({ snapshot: plan, prompt: 'check it', model });

    expect(result.steps).toBe(3);
    expect(result.assistantText).toBe('Added one group, check the island.');
    expect(result.operations.slice(0, baseline.length)).toEqual(baseline);
    expect(result.operations).toHaveLength(baseline.length + 1);
    expect(result.operations[baseline.length]).toMatchObject({ kind: 'logicGroup', source: 'ai', confidence: 'low' });
    expect(result.trace.map(step => step.tool)).toEqual(['get_baseline', 'list_floors', 'propose_exclusive_group']);
    expect(result.trace.every(step => step.ok)).toBe(true);
  });

  it('hands a refused proposal back to the model, which can fix it', async () => {
    const plan = snapshot();
    const island = uidOf(plan, 'Optional Island at Kitchen');
    const door = uidOf(plan, 'Optional Door at Primary Bath');

    const model = scripted([
      () => calling(call('propose_nest', { childUid: 'made-up', parentUid: door, reason: 'First try.', confidence: 'low' })),
      () => calling(call('propose_nest', { childUid: island, parentUid: door, reason: 'Second try.', confidence: 'low' })),
      () => answer('Done.')
    ]);

    const result = await runAgent({ snapshot: plan, model });
    const secondRequest = model.requests[1];
    const feedback = secondRequest.messages[secondRequest.messages.length - 1];

    expect(feedback).toMatchObject({ role: 'user', toolResults: [{ name: 'propose_nest', output: { error: expect.stringContaining('Unknown item "made-up"') } }] });
    expect(result.trace.map(step => step.ok)).toEqual([false, true]);
    expect(result.operations.filter(op => op.source === 'ai')).toHaveLength(1);
  });

  it('gives the model the system prompt, the tools, and a first message with the request', async () => {
    const plan = snapshot();
    const model = scripted([() => answer('Nothing to add.')]);

    await runAgent({ snapshot: plan, prompt: 'Bath 3 shower needs Bedroom 5', model });

    const first = model.requests[0];

    expect(first.system).toBe(AGENT_SYSTEM_PROMPT);
    expect(first.tools.map(tool => tool.name)).toEqual(TOOLS.map(tool => tool.name));
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({ role: 'user', text: expect.stringContaining('Bath 3 shower needs Bedroom 5') });
    expect((first.messages[0] as { text: string }).text).toContain('19 options');
    expect((first.messages[0] as { text: string }).text).toContain("builder's plan sheet (15 options)");
  });

  it('asks for the logic of the plan when the request is empty', async () => {
    const model = scripted([() => answer('ok')]);

    await runAgent({ snapshot: snapshot(), prompt: '   ', model });

    expect((model.requests[0].messages[0] as { text: string }).text).toContain('Suggest the logic for this plan.');
  });

  it('keeps the rules answer when the model fails', async () => {
    const plan = snapshot();
    const baseline = analyzeDeterministic(plan);
    const result = await runAgent({ snapshot: plan, model: { generate: async () => { throw new Error('503 overloaded'); } } });

    expect(result.operations).toEqual(baseline.operations);
    expect(result.findings.some(finding => finding.id === 'ai-failed' && finding.message.includes('503 overloaded'))).toBe(true);
    expect(result.steps).toBe(1);
  });

  it('keeps what the model proposed before it failed', async () => {
    const plan = snapshot();
    const island = uidOf(plan, 'Optional Island at Kitchen');
    const door = uidOf(plan, 'Optional Door at Primary Bath');
    const model = scripted([
      () => calling(call('propose_exclusive_group', { uids: [island, door], reason: 'Test group.', confidence: 'low' })),
      () => { throw new Error('connection lost'); }
    ]);

    const result = await runAgent({ snapshot: plan, model });

    expect(result.operations.filter(op => op.source === 'ai')).toHaveLength(1);
    expect(result.findings.find(finding => finding.id === 'ai-failed')?.message).toContain('plus what the AI proposed before failing');
  });

  it('stops a model that never finishes', async () => {
    const forever: ModelClient = { generate: async () => calling(call('list_floors', {})) };
    const result = await runAgent({ snapshot: snapshot(), model: forever, maxSteps: 4 });

    expect(result.steps).toBe(4);
    expect(result.trace).toHaveLength(4);
    expect(result.findings.some(finding => finding.id === 'ai-budget')).toBe(true);
  });

  it('stops a model that asks for too many tools at once', async () => {
    const greedy: ModelClient = { generate: async () => calling(...Array.from({ length: 10 }, () => call('list_floors', {}))) };
    const result = await runAgent({ snapshot: snapshot(), model: greedy, maxToolCalls: 25 });

    expect(result.trace.length).toBeLessThanOrEqual(30);
    expect(result.findings.some(finding => finding.id === 'ai-budget')).toBe(true);
  });

  it('works on a plan with no sheet and says so to the model', async () => {
    const model = scripted([() => answer('ok')]);

    await runAgent({ snapshot: woodberry(), model });

    expect((model.requests[0].messages[0] as { text: string }).text).toContain('no plan sheet');
  });

  it('tells the model the baseline is proposed, not applied, and keeps Pulte patterns out for now', () => {
    expect(AGENT_SYSTEM_PROMPT).toContain('proposals the user has not applied yet');
    expect(AGENT_SYSTEM_PROMPT).toContain('never say it is');
    expect(AGENT_SYSTEM_PROMPT).toContain('Never say the plan is configured');
    expect(AGENT_SYSTEM_PROMPT).not.toContain('Sound Dampened');
    expect(AGENT_SYSTEM_PROMPT).toContain('Bedroom 5 with Bath 3 replaces the Den');
  });

  it('the first message also says the proposals are not applied', async () => {
    const model = scripted([() => answer('ok')]);

    await runAgent({ snapshot: snapshot(), model });

    expect((model.requests[0].messages[0] as { text: string }).text).toContain('not applied yet');
  });

  it('the system prompt mentions every propose tool, so the two can not drift apart', () => {
    TOOLS.filter(tool => !tool.readOnly).forEach(tool => expect(AGENT_SYSTEM_PROMPT).toContain(tool.name));
  });
});
