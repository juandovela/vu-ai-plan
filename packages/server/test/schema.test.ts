import { planSheetSchema, toolDefinitions } from '@aivu/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sheetResponseSchema } from '../src/gemini/client';
import { toGeminiParameters, toGeminiSchema } from '../src/gemini/schema';

const ALLOWED_KEYS = ['type', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'anyOf'];
const TYPES = ['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY', 'OBJECT'];

/** Every keyword Gemini does not know is an error on its side. */
function assertGeminiShape(schema: any, path = 'schema'): void {
  Object.keys(schema).forEach(key => {
    expect(ALLOWED_KEYS, `${path}.${key}`).toContain(key);
  });

  if (schema.type !== undefined) expect(TYPES, `${path}.type`).toContain(schema.type);
  if (schema.properties) Object.keys(schema.properties).forEach(name => assertGeminiShape(schema.properties[name], `${path}.${name}`));
  if (schema.items) assertGeminiShape(schema.items, `${path}[]`);
  if (schema.anyOf) schema.anyOf.forEach((variant: any, i: number) => assertGeminiShape(variant, `${path}.anyOf${i}`));
  if (schema.required) schema.required.forEach((name: string) => expect(schema.properties, `${path}.required ${name}`).toHaveProperty(name));
}

describe('gemini schema', () => {
  it('rewrites every tool of the agent into what Gemini accepts', () => {
    toolDefinitions().forEach(tool => {
      const parameters = toGeminiParameters(tool.parameters);

      if (parameters) assertGeminiShape(parameters, tool.name);
    });
  });

  it('leaves a tool with no arguments without parameters, which Gemini requires', () => {
    ['list_floors', 'get_sheet', 'get_baseline', 'get_proposals'].forEach(name => {
      expect(toGeminiParameters(toolDefinitions().find(tool => tool.name === name)!.parameters)).toBeUndefined();
    });
    expect(toGeminiParameters(toolDefinitions().find(tool => tool.name === 'list_items')!.parameters)).toBeDefined();
  });

  it('turns a fixed length list into a list with a min and a max', () => {
    const pair = toGeminiParameters(toolDefinitions().find(tool => tool.name === 'propose_package')!.parameters) as any;

    expect(pair.properties.uids).toMatchObject({ type: 'ARRAY', items: { type: 'STRING' }, minItems: 2, maxItems: 2 });
  });

  it('keeps what the model needs to choose well', () => {
    const filter = toGeminiParameters(toolDefinitions().find(tool => tool.name === 'propose_filter')!.parameters) as any;

    expect(filter.properties.filter.enum).toContain('default');
    expect(filter.properties.filter.enum).not.toContain('none');
    expect(filter.properties.confidence.description).toContain('high');
    expect(filter.required).toEqual(expect.arrayContaining(['uid', 'filter', 'reason', 'confidence']));
  });

  it('writes "string or null" as nullable', () => {
    expect(toGeminiSchema(z.toJSONSchema(z.string().nullable()))).toEqual({ type: 'STRING', nullable: true });
    expect(toGeminiSchema({ anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'floor' })).toEqual({ type: 'INTEGER', nullable: true, description: 'floor' });
    expect(toGeminiSchema({ type: ['string', 'null'] })).toEqual({ type: 'STRING', nullable: true });
  });

  it('drops what Gemini refuses', () => {
    const out = toGeminiSchema({
      $schema: 'x', $id: 'y', title: 'T', additionalProperties: false, default: 1, pattern: '^a', format: 'safeint',
      type: 'object', properties: { a: { type: 'string', pattern: 'x', default: 'q' } }, required: ['a', 'ghost']
    });

    expect(out).toEqual({ type: 'OBJECT', properties: { a: { type: 'STRING' } }, required: ['a'] });
  });

  it('turns a constant into an enum and ignores absurd bounds', () => {
    expect(toGeminiSchema({ const: 'x' })).toEqual({ type: 'STRING', enum: ['x'] });
    expect(toGeminiSchema({ type: 'integer', minimum: -9007199254740991, maximum: 5 })).toEqual({ type: 'INTEGER', maximum: 5 });
  });

  it('describes the plan sheet the model has to fill', () => {
    const schema = sheetResponseSchema() as any;

    assertGeminiShape(schema, 'sheet');
    expect(schema.type).toBe('OBJECT');
    expect(schema.properties.planName).toMatchObject({ type: 'STRING', nullable: true });
    expect(schema.properties.options.items.properties.replaces).toMatchObject({ type: 'ARRAY', items: { type: 'STRING' } });
    expect(schema.properties.options.items.properties.floorNumber).toMatchObject({ type: 'INTEGER', nullable: true });
    // the output schema: the model has to give every field, not only some
    expect(schema.properties.options.items.required).toEqual(expect.arrayContaining(['location', 'name', 'replaces', 'adds', 'caption', 'insetKey', 'marker']));
    expect(Object.keys(schema.properties)).toEqual(Object.keys(planSheetSchema.shape));
  });
});
