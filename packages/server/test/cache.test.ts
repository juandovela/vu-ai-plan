import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planSheetSchema, type ModelClient, type PlanSheet } from '@aivu/core';
import { describe, expect, it } from 'vitest';

import { canonicalJson, kvCache, memoryCache, sha256Hex, type KVLike } from '../src/cache';
import { answer, auth, makeApp, pdf } from './helpers';

const core = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'test', 'fixtures');
const snapshot = () => JSON.parse(readFileSync(join(core, 'woodberry-2557.snapshot.json'), 'utf8'));
const sheet = (): PlanSheet => planSheetSchema.parse(JSON.parse(readFileSync(join(core, 'woodberry-2557.sheet.json'), 'utf8')));

const analyze = (app: ReturnType<typeof makeApp>['app'], body: unknown) =>
  app.request('/v1/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(body) });

const upload = (app: ReturnType<typeof makeApp>['app'], bytes: Uint8Array) => {
  const form = new FormData();

  form.append('pdf', new File([bytes as BlobPart], 'sheet.pdf', { type: 'application/pdf' }));

  return app.request('/v1/sheet', { method: 'POST', headers: auth, body: form });
};

const lookup = (app: ReturnType<typeof makeApp>['app'], hash: string) => app.request(`/v1/sheet/${hash}`, { headers: auth });

/** A model that counts how many times it is asked. */
const counting = () => {
  const calls = { n: 0 };
  const model: ModelClient = {
    generate: async () => {
      calls.n++;

      return answer('Nothing to change.');
    }
  };

  return { calls, model };
};

describe('hashing', () => {
  it('hashes like sha256sum does', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('writes the same text whatever the order of the keys', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }, 3] })).toBe(canonicalJson({ a: [{ d: 2 }, 3], b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});

describe('POST /v1/sheet with a cache', () => {
  it('reads the PDF once and answers the second time from the cache', async () => {
    let reads = 0;
    const cache = memoryCache();
    const { app } = makeApp({}, { cache, readSheet: async () => (reads++, sheet()) });
    const first = await upload(app, pdf());
    const second = await upload(app, pdf());

    expect(first.headers.get('X-Cache')).toBe('miss');
    expect(second.headers.get('X-Cache')).toBe('hit');
    expect(reads).toBe(1);
    expect((await second.json()).sheet.planName).toBe('Plan 2557');
  });

  it('is a different PDF, a different answer', async () => {
    let reads = 0;
    const { app } = makeApp({}, { cache: memoryCache(), readSheet: async () => (reads++, sheet()) });

    await upload(app, pdf(200));
    await upload(app, pdf(300));

    expect(reads).toBe(2);
  });

  it('does not keep a PDF that could not be read', async () => {
    let reads = 0;
    const cache = memoryCache();
    const { app } = makeApp({}, { cache, readSheet: async () => { reads++; throw new Error('boom'); } });

    expect((await upload(app, pdf())).status).toBe(502);
    expect((await upload(app, pdf())).status).toBe(502);
    expect(reads).toBe(2);
    expect(cache.entries.size).toBe(0);
  });

  it('does not use the cache when it is not given, as before', async () => {
    let reads = 0;
    const { app } = makeApp({}, { readSheet: async () => (reads++, sheet()) });

    await upload(app, pdf());
    await upload(app, pdf());

    expect(reads).toBe(2);
  });

  it('survives a cache that fails', async () => {
    const broken: KVLike = {
      get: async () => { throw new Error('kv down'); },
      put: async () => { throw new Error('kv down'); }
    };
    const { app } = makeApp({}, { cache: kvCache(broken), readSheet: async () => sheet() });
    const response = await upload(app, pdf());

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache')).toBe('miss');
  });

  it('forgets the answers when the model changes', async () => {
    let reads = 0;
    const cache = memoryCache();
    const reader = async () => (reads++, sheet());

    await upload(makeApp({ GEMINI_MODEL: 'model-a' }, { cache, readSheet: reader }).app, pdf());
    await upload(makeApp({ GEMINI_MODEL: 'model-b' }, { cache, readSheet: reader }).app, pdf());

    expect(reads).toBe(2);
  });
});

describe('GET /v1/sheet/:sha256', () => {
  it('says it is not there, then returns the sheet without the PDF', async () => {
    const { app } = makeApp({}, { cache: memoryCache(), readSheet: async () => sheet() });
    const hash = await sha256Hex(pdf());
    const before = await (await lookup(app, hash)).json();

    expect(before).toEqual({ contractVersion: 1, cached: false });

    await upload(app, pdf());

    const response = await lookup(app, hash);
    const after = await response.json();

    expect(response.headers.get('X-Cache')).toBe('hit');
    expect(after.cached).toBe(true);
    expect(after.sheet.planName).toBe('Plan 2557');
  });

  it('is answered even when the AI is not configured, the sheet is already there', async () => {
    const cache = memoryCache();

    await upload(makeApp({}, { cache, readSheet: async () => sheet() }).app, pdf());

    const { app } = makeApp({}, { cache, readSheet: null });
    const body = await (await lookup(app, await sha256Hex(pdf()))).json();

    expect(body.cached).toBe(true);
  });

  it('refuses what is not a sha-256 and a request without a token', async () => {
    const { app } = makeApp({}, { cache: memoryCache() });

    expect((await lookup(app, 'abc')).status).toBe(400);
    expect((await app.request(`/v1/sheet/${'0'.repeat(64)}`)).status).toBe(401);
  });

  it('answers "not cached" when there is no cache at all', async () => {
    const { app } = makeApp();

    expect(await (await lookup(app, '0'.repeat(64))).json()).toEqual({ contractVersion: 1, cached: false });
  });
});

describe('POST /v1/analyze with a cache', () => {
  it('asks the model once for the same plan and question', async () => {
    const { calls, model } = counting();
    const { app } = makeApp({}, { cache: memoryCache(), model });
    const body = { contractVersion: 1, snapshot: snapshot(), prompt: 'group the cabinets' };
    const first = await analyze(app, body);
    const second = await analyze(app, body);

    expect(first.headers.get('X-Cache')).toBe('miss');
    expect(second.headers.get('X-Cache')).toBe('hit');
    expect(calls.n).toBe(1);
    expect((await second.json()).assistantText).toBe('Nothing to change.');
  });

  it('asks again when the question or the plan changes', async () => {
    const { calls, model } = counting();
    const { app } = makeApp({}, { cache: memoryCache(), model });

    await analyze(app, { contractVersion: 1, snapshot: snapshot(), prompt: 'one' });
    await analyze(app, { contractVersion: 1, snapshot: snapshot(), prompt: 'two' });

    const plan = snapshot();

    plan.items[0] = { ...plan.items[0], name: 'Renamed option' };

    await analyze(app, { contractVersion: 1, snapshot: plan, prompt: 'one' });

    expect(calls.n).toBe(3);
  });

  it('does not keep an answer made without the model', async () => {
    const failing: ModelClient = { generate: async () => { throw new Error('model down'); } };
    const cache = memoryCache();
    const { app } = makeApp({}, { cache, model: failing });
    const response = await analyze(app, { contractVersion: 1, snapshot: snapshot() });
    const body = await response.json();

    expect(body.findings.some((finding: { id: string }) => finding.id === 'ai-failed')).toBe(true);
    expect(cache.entries.size).toBe(0);
  });

  it('does not touch the cache when there is no model', async () => {
    const cache = memoryCache();
    const response = await analyze(makeApp({}, { cache }).app, { contractVersion: 1, snapshot: snapshot() });

    expect(response.status).toBe(200);
    expect(cache.entries.size).toBe(0);
  });
});
