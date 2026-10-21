import { z } from 'zod';

import {
  analyzeRequestSchema,
  analyzeResponseSchema,
  errorResponseSchema,
  operationSchema,
  planSheetSchema,
  sheetResponseSchema,
  snapshotSchema
} from './contract';

/**
 * JSON Schemas of the contract, for clients that are not TypeScript and for
 * documentation. What a client sends is described as input (fields with a
 * default are optional), what it receives as output.
 */
export function contractJsonSchemas(): { [name: string]: unknown } {
  const options = { target: 'draft-2020-12' as const };

  return {
    'analyze-request': z.toJSONSchema(analyzeRequestSchema, { ...options, io: 'input' }),
    'analyze-response': z.toJSONSchema(analyzeResponseSchema, { ...options, io: 'output' }),
    'sheet-response': z.toJSONSchema(sheetResponseSchema, { ...options, io: 'output' }),
    'error-response': z.toJSONSchema(errorResponseSchema, { ...options, io: 'output' }),
    snapshot: z.toJSONSchema(snapshotSchema, { ...options, io: 'input' }),
    'plan-sheet': z.toJSONSchema(planSheetSchema, { ...options, io: 'input' }),
    operation: z.toJSONSchema(operationSchema, { ...options, io: 'output' })
  };
}
