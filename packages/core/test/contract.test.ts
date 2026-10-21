import { describe, expect, it } from 'vitest';

import {
  analyzeRequestSchema,
  analyzeResponseSchema,
  contractJsonSchemas,
  CONTRACT_VERSION,
  OPERATION_KINDS,
  operationSchema
} from '../src';
import { woodberry, woodberrySheet } from './helpers';

describe('contract', () => {
  it('accepts a request and fills in the defaults', () => {
    const request = analyzeRequestSchema.parse({
      contractVersion: CONTRACT_VERSION,
      snapshot: { floors: [], items: [], elevations: [], floorLabels: {} }
    });

    expect(request.prompt).toBe('');
    expect(request.snapshot.sheet).toBeNull();
    expect(request.snapshot.glossary).toEqual({});
  });

  it('accepts the real plan and its sheet', () => {
    const request = analyzeRequestSchema.parse({
      contractVersion: CONTRACT_VERSION,
      snapshot: { ...woodberry(), sheet: woodberrySheet() },
      prompt: 'Bath 3 shower only works with Bedroom 5'
    });

    expect(request.snapshot.items).toHaveLength(19);
    expect(request.snapshot.sheet?.options).toHaveLength(15);
  });

  it('rejects another contract version', () => {
    const result = analyzeRequestSchema.safeParse({
      contractVersion: 2,
      snapshot: { floors: [], items: [], elevations: [], floorLabels: {} }
    });

    expect(result.success).toBe(false);
  });

  it('rejects an operation it does not know or that is incomplete', () => {
    const base = { id: 'x', reason: 'because', confidence: 'high', source: 'ai' };

    expect(operationSchema.safeParse({ ...base, kind: 'delete', listItemUid: 'a' }).success).toBe(false);
    expect(operationSchema.safeParse({ ...base, kind: 'logicGroup', listItemUids: ['a'] }).success).toBe(false);
    expect(operationSchema.safeParse({ ...base, kind: 'package', listItemUids: ['a', 'b', 'c'] }).success).toBe(false);
    expect(operationSchema.safeParse({ ...base, kind: 'filter', listItemUid: 'a', filter: 'sparkly' }).success).toBe(false);
    expect(operationSchema.safeParse({ ...base, kind: 'nest', childUid: 'a', parentUid: 'b' }).success).toBe(true);
  });

  it('validates a response', () => {
    const response = analyzeResponseSchema.parse({
      contractVersion: CONTRACT_VERSION,
      operations: [],
      findings: [{ id: 'f', severity: 'info', message: 'ok' }],
      assistantText: ''
    });

    expect(response.trace).toEqual([]);
  });

  it('publishes a JSON Schema for every operation kind', () => {
    const schemas = contractJsonSchemas();
    const operation = JSON.stringify(schemas.operation);

    OPERATION_KINDS.forEach(kind => expect(operation).toContain(`"${kind}"`));
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(['analyze-request', 'analyze-response', 'sheet-response', 'error-response', 'snapshot', 'plan-sheet', 'operation'])
    );

    const request = schemas['analyze-request'] as { required: string[] };

    expect(request.required).toEqual(expect.arrayContaining(['contractVersion', 'snapshot']));
  });
});
