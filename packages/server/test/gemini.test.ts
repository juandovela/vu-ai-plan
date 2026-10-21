import { toolDefinitions, type ModelRequest } from '@aivu/core';
import { describe, expect, it } from 'vitest';

import { buildAgentBody, GeminiError, GeminiModelClient, readSheetWithGemini, toBase64, toGeminiContents, type GeminiOptions } from '../src/gemini/client';
import { pdf } from './helpers';

type Reply = { status?: number; body?: unknown } | Error;

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: any; body: any }> = [];
  const fn = (async (url: string, init: any) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)];

    calls.push({ url, init, body: JSON.parse(init.body) });

    if (reply instanceof Error) throw reply;

    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;

  return { calls, fn };
}

const ok = (parts: unknown[], extra: object = {}) => ({ body: { candidates: [{ content: { role: 'model', parts }, ...extra }] } });

const options = (fetchFn: typeof fetch, sleeps: number[] = []): GeminiOptions => ({
  apiKey: 'SECRET-KEY',
  model: 'gemini-3.5-flash-lite',
  baseUrl: 'https://gemini.test',
  fetchFn,
  sleep: async ms => void sleeps.push(ms)
});

const request: ModelRequest = {
  system: 'You configure plans.',
  messages: [{ role: 'user', text: 'Go.' }],
  tools: toolDefinitions()
};

describe('gemini agent client', () => {
  it('asks the way the functions did: same API, key in a header, tools declared', async () => {
    const { calls, fn } = fakeFetch([ok([{ text: 'hi' }])]);

    await new GeminiModelClient(options(fn)).generate(request);

    const [call] = calls;

    expect(call.url).toBe('https://gemini.test/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(call.url).not.toContain('SECRET-KEY');
    expect(call.init.headers['x-goog-api-key']).toBe('SECRET-KEY');
    expect(call.body.systemInstruction.parts[0].text).toBe('You configure plans.');
    expect(call.body.contents).toEqual([{ role: 'user', parts: [{ text: 'Go.' }] }]);
    expect(call.body.toolConfig.functionCallingConfig.mode).toBe('AUTO');
    expect(call.body.generationConfig.temperature).toBe(0);
    expect(call.body.tools[0].functionDeclarations).toHaveLength(14);

    const declared = (name: string) => call.body.tools[0].functionDeclarations.find((d: any) => d.name === name);

    expect(declared('list_floors')).not.toHaveProperty('parameters');
    expect(declared('propose_nest').parameters.type).toBe('OBJECT');
  });

  it('reads the answer: text, tool calls, and ignores the model thinking aloud', async () => {
    const { fn } = fakeFetch([
      ok([
        { text: 'Let me think...', thought: true },
        { functionCall: { name: 'list_items', args: { floorUid: 'floor-1' } }, thoughtSignature: 'sig-1' },
        { functionCall: { name: 'get_sheet' } }
      ])
    ]);

    const response = await new GeminiModelClient(options(fn)).generate(request);

    expect(response.text).toBe('');
    expect(response.toolCalls).toEqual([
      { name: 'list_items', args: { floorUid: 'floor-1' } },
      { name: 'get_sheet', args: {} }
    ]);
  });

  it('gives Gemini its own message back, signatures included', async () => {
    const { fn } = fakeFetch([ok([{ functionCall: { name: 'list_items', args: {} }, thoughtSignature: 'sig-1' }])]);
    const response = await new GeminiModelClient(options(fn)).generate(request);

    const contents = toGeminiContents([
      { role: 'user', text: 'Go.' },
      { role: 'model', toolCalls: response.toolCalls, raw: response.raw },
      { role: 'user', toolResults: [{ name: 'list_items', output: [{ uid: 'a' }] }] }
    ]);

    expect(contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'list_items', args: {} }, thoughtSignature: 'sig-1' }] });
  });

  it('builds the model turn itself when there is nothing to hand back', () => {
    const contents = toGeminiContents([{ role: 'model', text: 'ok', toolCalls: [{ name: 'get_sheet', args: undefined }] }]);

    expect(contents[0].parts).toEqual([{ text: 'ok' }, { functionCall: { name: 'get_sheet', args: {} } }]);
  });

  it('wraps tool results into the object Gemini requires', () => {
    const [content] = toGeminiContents([
      {
        role: 'user',
        toolResults: [
          { name: 'list_items', output: [{ uid: 'a' }] },
          { name: 'propose_nest', output: { error: 'Unknown item "x".' } },
          { name: 'get_sheet', output: null },
          { name: 'get_floor_labels', output: 'plain' }
        ]
      }
    ]);

    expect(content.parts.map((part: any) => part.functionResponse.response)).toEqual([
      { output: [{ uid: 'a' }] },
      { error: 'Unknown item "x".' },
      { output: null },
      { output: 'plain' }
    ]);
  });

  it('tries again on 503 and 429, waiting longer each time', async () => {
    const sleeps: number[] = [];
    const { calls, fn } = fakeFetch([{ status: 503, body: { error: { message: 'overloaded' } } }, { status: 429, body: {} }, ok([{ text: 'finally' }])]);

    const response = await new GeminiModelClient(options(fn, sleeps)).generate(request);

    expect(response.text).toBe('finally');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([400, 800]);
  });

  it('gives up after the retries and says what Google said, never the key', async () => {
    const { calls, fn } = fakeFetch([{ status: 429, body: { error: { message: 'Quota exceeded' } } }]);
    const failure = await new GeminiModelClient(options(fn)).generate(request).catch(error => error);

    expect(failure).toBeInstanceOf(GeminiError);
    expect(failure.status).toBe(429);
    expect(failure.message).toContain('Quota exceeded');
    expect(failure.message).not.toContain('SECRET-KEY');
    expect(calls).toHaveLength(3);
  });

  it('does not retry what retrying can not fix', async () => {
    const { calls, fn } = fakeFetch([{ status: 400, body: { error: { message: 'Invalid schema' } } }]);

    await expect(new GeminiModelClient(options(fn)).generate(request)).rejects.toThrow('Invalid schema');
    expect(calls).toHaveLength(1);
  });

  it('survives a network failure and then reports it', async () => {
    const { calls, fn } = fakeFetch([new TypeError('fetch failed')]);

    await expect(new GeminiModelClient(options(fn)).generate(request)).rejects.toThrow('not reachable');
    expect(calls).toHaveLength(3);
  });

  it('tells an empty answer from one Gemini declined to give', async () => {
    await expect(new GeminiModelClient(options(fakeFetch([{ body: { candidates: [] } }]).fn)).generate(request)).rejects.toThrow('empty response');
    await expect(
      new GeminiModelClient(options(fakeFetch([{ body: { candidates: [{ finishReason: 'SAFETY' }] } }]).fn)).generate(request)
    ).rejects.toThrow('declined to answer (SAFETY)');
  });

  it('builds the same body the client sends', () => {
    expect(buildAgentBody(request).contents).toEqual(toGeminiContents(request.messages));
  });
});

describe('gemini plan sheet reader', () => {
  const reading = { planName: ' Plan  2557 ', specs: { sqft: '2,557', bedrooms: null, baths: null }, elevations: ['Elevation B'], notes: [], options: [{ floorNumber: 1, location: 'Den', name: 'Door', caption: 'Door at Den', insetKey: 'k', replaces: [], adds: [], marker: null }] };

  it('sends the pdf and the schema, and returns a clean sheet', async () => {
    const { calls, fn } = fakeFetch([ok([{ text: JSON.stringify(reading) }])]);
    const file = pdf(70000);
    const sheet = await readSheetWithGemini(options(fn), file);
    const body = calls[0].body;

    expect(body.contents[0].parts[1].inlineData).toEqual({ mimeType: 'application/pdf', data: Buffer.from(file).toString('base64') });
    expect(body.generationConfig).toMatchObject({ temperature: 0, responseMimeType: 'application/json' });
    expect(body.generationConfig.responseSchema.type).toBe('OBJECT');
    expect(body.systemInstruction.parts[0].text).toContain('plan sheet');
    expect(sheet.planName).toBe('Plan 2557');
    expect(sheet.options[0]).toMatchObject({ name: 'Door', location: 'Den', replaces: [] });
  });

  it('refuses an empty reading and a reading that is not a sheet', async () => {
    await expect(readSheetWithGemini(options(fakeFetch([ok([])]).fn), pdf())).rejects.toThrow('empty response');
    await expect(readSheetWithGemini(options(fakeFetch([ok([{ text: 'I could not read it' }])]).fn), pdf())).rejects.toThrow('readable plan sheet');
    await expect(readSheetWithGemini(options(fakeFetch([ok([{ text: '"just a string"' }])]).fn), pdf())).rejects.toThrow('readable plan sheet');
  });

  it('encodes any size to base64 like Node does', () => {
    [0, 1, 2, 3, 32767, 32768, 32769, 100000].forEach(size => {
      const bytes = new Uint8Array(size).map((_, i) => (i * 7) % 256);

      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    });
  });
});
