/**
 * Gemini over its REST API (generateContent). Same API and model the Firebase
 * functions used, called with fetch so it runs in a Worker.
 *
 * Two uses: an agent that calls tools (GeminiModelClient), and reading a plan
 * sheet PDF into the contract's shape (readSheetWithGemini).
 */

import {
  normalizePlanSheet,
  planSheetSchema,
  SHEET_EXTRACTION_PROMPT,
  type ModelClient,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type PlanSheet
} from '@aivu/core';
import { z } from 'zod';

import { toGeminiParameters, toGeminiSchema } from './schema';

export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchFn?: typeof fetch;
  /** Extra attempts on 429 and 5xx. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

const RETRIABLE = [429, 500, 502, 503, 504];
const BLOCKED = ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'];

type Part = Record<string, any>;

async function generate(options: GeminiOptions, body: unknown): Promise<any> {
  const send = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const url = `${options.baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:generateContent`;
  const attempts = (options.retries ?? 2) + 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;

    try {
      response = await send(url, {
        method: 'POST',
        // the key goes in a header, never in the url: urls end up in logs
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': options.apiKey },
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (attempt < attempts - 1) {
        await sleep(400 * 2 ** attempt);
        continue;
      }

      throw new GeminiError('Gemini is not reachable.');
    }

    const json: any = await response.json().catch(() => null);

    if (response.ok) {
      return json;
    }

    if (RETRIABLE.indexOf(response.status) !== -1 && attempt < attempts - 1) {
      await sleep(400 * 2 ** attempt);
      continue;
    }

    throw new GeminiError(
      `Gemini request failed (${response.status}): ${json?.error?.message ?? 'no details'}`,
      response.status
    );
  }

  throw new GeminiError('Gemini request failed.');
}

/**
 * The tool results go back to Gemini as functionResponse parts, which must be
 * an object.
 */
const asObject = (output: unknown) =>
  output !== null && typeof output === 'object' && !Array.isArray(output) ? output : { output };

export function toGeminiContents(messages: ModelMessage[]): Array<{ role: string; parts: Part[] }> {
  return messages.map(message => {
    if (message.role === 'model') {
      /**
       * Give back exactly what Gemini sent: its function calls can carry a
       * thought signature that it needs in the next turn.
       */
      const raw = message.raw as { parts?: Part[] } | undefined;

      if (raw && Array.isArray(raw.parts)) {
        return { role: 'model', parts: raw.parts };
      }

      return {
        role: 'model',
        parts: [
          ...(message.text ? [{ text: message.text }] : []),
          ...(message.toolCalls ?? []).map(call => ({ functionCall: { name: call.name, args: call.args ?? {} } }))
        ]
      };
    }

    return {
      role: 'user',
      parts: [
        ...(message.text ? [{ text: message.text }] : []),
        ...(message.toolResults ?? []).map(result => ({
          functionResponse: { name: result.name, response: asObject(result.output) }
        }))
      ]
    };
  });
}

export function buildAgentBody(request: ModelRequest) {
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: toGeminiContents(request.messages),
    tools: [
      {
        functionDeclarations: request.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          ...(toGeminiParameters(tool.parameters) ? { parameters: toGeminiParameters(tool.parameters) } : {})
        }))
      }
    ],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: { temperature: 0 }
  };
}

export class GeminiModelClient implements ModelClient {
  constructor(private readonly options: GeminiOptions) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const json = await generate(this.options, buildAgentBody(request));
    const candidate = json?.candidates?.[0];
    const parts: Part[] = candidate?.content?.parts ?? [];

    if (parts.length === 0) {
      const reason = candidate?.finishReason ?? json?.promptFeedback?.blockReason;

      throw new GeminiError(
        reason && BLOCKED.indexOf(reason) !== -1
          ? `Gemini declined to answer (${reason}).`
          : 'Gemini returned an empty response.'
      );
    }

    return {
      // thought parts are the model thinking aloud, not the answer
      text: parts
        .filter(part => typeof part.text === 'string' && !part.thought)
        .map(part => part.text)
        .join('')
        .trim(),
      toolCalls: parts
        .filter(part => part.functionCall && typeof part.functionCall.name === 'string')
        .map(part => ({ name: part.functionCall.name as string, args: part.functionCall.args ?? {} })),
      raw: candidate.content
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Plan sheet (PDF)                                                            */
/* -------------------------------------------------------------------------- */

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

let sheetSchema: Record<string, unknown> | null = null;

/** What the model has to fill, from the same schema as the contract. */
export const sheetResponseSchema = () =>
  (sheetSchema ??= toGeminiSchema(z.toJSONSchema(planSheetSchema, { target: 'draft-2020-12', io: 'output' })));

export async function readSheetWithGemini(options: GeminiOptions, pdf: Uint8Array): Promise<PlanSheet> {
  const json = await generate(options, {
    systemInstruction: { parts: [{ text: SHEET_EXTRACTION_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Extract the plan sheet.' }, { inlineData: { mimeType: 'application/pdf', data: toBase64(pdf) } }]
      }
    ],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: sheetResponseSchema() }
  });

  const text: string | undefined = json?.candidates?.[0]?.content?.parts
    ?.filter((part: Part) => typeof part.text === 'string' && !part.thought)
    .map((part: Part) => part.text)
    .join('')
    .trim();

  if (!text) {
    throw new GeminiError('Gemini returned an empty response.');
  }

  try {
    return normalizePlanSheet(JSON.parse(text));
  } catch (error) {
    throw new GeminiError('Gemini did not return a readable plan sheet.');
  }
}
