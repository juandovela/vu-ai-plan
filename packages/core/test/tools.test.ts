import { describe, expect, it } from 'vitest';

import { analyzeDeterministic, executeTool, TOOLS, toolDefinitions, VirtualPlan } from '../src';
import { uidOf, woodberry, woodberrySheet } from './helpers';

const start = () => {
  const snapshot = { ...woodberry(), sheet: woodberrySheet() };
  const baseline = analyzeDeterministic(snapshot).operations;

  return { snapshot, plan: new VirtualPlan(snapshot, baseline) };
};

describe('tools', () => {
  it('works on a copy: the snapshot it was given is never touched', () => {
    const { snapshot, plan } = start();
    const before = JSON.stringify(snapshot);

    plan.item('item-01')!.name = 'changed in the copy';
    executeTool(plan, 'propose_package', {
      uids: [uidOf(snapshot, 'Optional Upper Cabinets at Kitchen'), uidOf(snapshot, 'Optional Lower Cabinets at Kitchen')],
      reason: 'drawn together',
      confidence: 'medium'
    });

    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('reads the plan', () => {
    const { snapshot, plan } = start();

    expect((executeTool(plan, 'list_floors', {}).result as unknown[]).length).toBe(2);

    const second = executeTool(plan, 'list_items', { floorUid: 'floor-2' }).result as Array<{ floorUid: string }>;

    expect(second.length).toBeGreaterThan(0);
    expect(second.every(candidate => candidate.floorUid === 'floor-2')).toBe(true);
    expect((executeTool(plan, 'get_item', { uid: uidOf(snapshot, 'Optional Door at Den') }).result as { name: string }).name).toBe('Optional Door at Den');
    expect(executeTool(plan, 'get_sheet', {}).result).toMatchObject({ planName: 'Plan 2557' });
    expect((executeTool(plan, 'get_baseline', {}).result as unknown[]).length).toBeGreaterThan(5);
  });

  it('records a valid proposal as an AI operation and hands it back', () => {
    const { snapshot, plan } = start();
    const outcome = executeTool(plan, 'propose_package', {
      uids: [uidOf(snapshot, 'Optional Lower Cabinets at Kitchen'), uidOf(snapshot, 'Optional Upper Cabinets at Kitchen')],
      reason: 'The sheet draws them together.',
      confidence: 'medium'
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(plan.proposed()).toHaveLength(1);
    expect(plan.proposed()[0]).toMatchObject({ kind: 'package', source: 'ai', confidence: 'medium' });
    // the id does not depend on the order the uids were given in
    expect(plan.proposed()[0].id).toBe(`package:${uidOf(snapshot, 'Optional Upper Cabinets at Kitchen')}+${uidOf(snapshot, 'Optional Lower Cabinets at Kitchen')}`);
  });

  it('refuses what the rules already proposed, and what was proposed twice', () => {
    const { snapshot, plan } = start();
    const input = {
      uids: [uidOf(snapshot, 'Optional Elevation D at Floor 1'), uidOf(snapshot, 'Optional Elevation E at Floor 1')],
      reason: 'Two elevations.',
      confidence: 'high'
    };

    expect(executeTool(plan, 'propose_exclusive_group', input)).toMatchObject({ ok: false, error: expect.stringContaining('Already proposed by the rules') });

    const unique = { uids: [uidOf(snapshot, 'Optional Island at Kitchen'), uidOf(snapshot, 'Optional Door at Primary Bath')], reason: 'Test.', confidence: 'low' };

    expect(executeTool(plan, 'propose_exclusive_group', unique).ok).toBe(true);
    // the copy already has the group, so it is refused for that reason
    expect(executeTool(plan, 'propose_exclusive_group', unique)).toMatchObject({ ok: false, error: expect.stringMatching(/already/i) });
  });

  it('says what is wrong so the caller can fix it', () => {
    const { snapshot, plan } = start();
    const run = (name: string, input: unknown) => executeTool(plan, name, input);
    const door = uidOf(snapshot, 'Optional Door at Den');

    expect(run('propose_nest', { childUid: 'nope', parentUid: door, reason: 'x y z', confidence: 'low' }).error).toContain('Unknown item "nope"');
    expect(run('propose_nest', { childUid: door, parentUid: door, reason: 'x y z', confidence: 'low' }).error).toContain('depend on itself');
    expect(run('propose_floor_link', { uid: door, floorUid: 'floor-9', reason: 'x y z', confidence: 'low' }).error).toContain('Unknown floor');
    expect(run('propose_filter', { uid: door, filter: 'none', reason: 'x y z', confidence: 'low' }).ok).toBe(false);
    expect(run('propose_filter', { uid: door, filter: 'sparkly', reason: 'x y z', confidence: 'low' }).ok).toBe(false);
    expect(run('propose_rename', { uid: door, to: 'Optional Door at Den', reason: 'x y z', confidence: 'low' }).error).toContain('already that');
    expect(run('propose_rename', { uid: door, reason: 'missing the new name', confidence: 'low' }).error).toContain('to');
    expect(run('propose_exclusive_group', { uids: [door], reason: 'x y z', confidence: 'low' }).ok).toBe(false);
    expect(run('no_such_tool', {})).toMatchObject({ ok: false, error: 'Unknown tool "no_such_tool".' });
  });

  it('refuses a dependency that would make a cycle, however long', () => {
    const { snapshot, plan } = start();
    const [a, b, c] = ['Optional Island at Kitchen', 'Optional Door at Primary Bath', 'Optional Vanity with Dual Sinks at Bath 2'].map(name => uidOf(snapshot, name));
    const call = (child: string, parent: string) =>
      executeTool(plan, 'propose_nest', { childUid: child, parentUid: parent, reason: 'test', confidence: 'low' });

    expect(call(a, b).ok).toBe(true);
    expect(call(b, c).ok).toBe(true);
    expect(call(b, a)).toMatchObject({ ok: false, error: expect.stringContaining('cycle') });
    expect(call(c, a)).toMatchObject({ ok: false, error: expect.stringContaining('cycle') });
  });

  it('shows what was proposed when the plan is read again', () => {
    const { snapshot, plan } = start();
    const [a, b] = ['Optional Island at Kitchen', 'Optional Door at Primary Bath'].map(name => uidOf(snapshot, name));

    executeTool(plan, 'propose_exclusive_group', { uids: [a, b], reason: 'test', confidence: 'low' });
    executeTool(plan, 'propose_filter', { uid: a, filter: 'hide', reason: 'test', confidence: 'low' });
    executeTool(plan, 'propose_rename', { uid: b, to: 'Renamed door', reason: 'test', confidence: 'low' });

    const read = (uid: string) => executeTool(plan, 'get_item', { uid }).result as { name: string; logic: number[]; filter: string[] };

    expect(read(a).logic).toHaveLength(1);
    expect(read(a).logic).toEqual(read(b).logic);
    expect(read(a).filter).toEqual(['hide']);
    expect(read(b).name).toBe('Renamed door');

    // and a second group is a different group
    executeTool(plan, 'propose_exclusive_group', { uids: [a, uidOf(snapshot, 'Optional Vanity with Dual Sinks at Bath 2')], reason: 'test', confidence: 'low' });
    expect(read(a).logic).toHaveLength(2);
    expect(new Set(read(a).logic).size).toBe(2);

    // the same thing can not be proposed again once it is part of the copy
    expect(executeTool(plan, 'propose_filter', { uid: a, filter: 'hide', reason: 'test', confidence: 'low' }).ok).toBe(false);
  });

  it('never throws, whatever it is given', () => {
    const { plan } = start();

    [undefined, null, 5, 'x', [], {}, { uids: 'no' }].forEach(input =>
      TOOLS.forEach(tool => expect(() => executeTool(plan, tool.name, input)).not.toThrow())
    );
  });

  it('describes its tools for a model', () => {
    const definitions = toolDefinitions();

    expect(definitions.map(definition => definition.name)).toEqual(TOOLS.map(tool => tool.name));
    expect(definitions).toHaveLength(14);
    definitions.forEach(definition => {
      expect(definition.description.length).toBeGreaterThan(10);
      expect(definition.parameters).toMatchObject({ type: 'object' });
      expect(definition.parameters).not.toHaveProperty('$schema');
    });

    const nest = definitions.find(definition => definition.name === 'propose_nest')!.parameters as { required: string[] };

    expect(nest.required).toEqual(expect.arrayContaining(['childUid', 'parentUid', 'reason', 'confidence']));
  });
});
