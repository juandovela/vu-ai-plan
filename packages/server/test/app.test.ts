import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeResponseSchema, errorResponseSchema, planSheetSchema, sheetResponseSchema, type PlanSheet } from '@aivu/core';
import { describe, expect, it } from 'vitest';

import { HttpError } from '../src/errors';
import { readConfig } from '../src/env';
import { answer, auth, makeApp, pdf, scripted } from './helpers';

const core = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'test', 'fixtures');
const snapshot = () => JSON.parse(readFileSync(join(core, 'woodberry-2557.snapshot.json'), 'utf8'));
const sheet = (): PlanSheet => planSheetSchema.parse(JSON.parse(readFileSync(join(core, 'woodberry-2557.sheet.json'), 'utf8')));

const post = (app: ReturnType<typeof makeApp>['app'], path: string, body: unknown, headers: Record<string, string> = auth) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const request = (extra: object = {}) => ({ contractVersion: 1, snapshot: snapshot(), ...extra });

const upload = (app: ReturnType<typeof makeApp>['app'], bytes: Uint8Array, headers: Record<string, string> = auth, field = 'pdf') => {
  const form = new FormData();

  form.append(field, new File([bytes as BlobPart], 'sheet.pdf', { type: 'application/pdf' }));

  return app.request('/v1/sheet', { method: 'POST', headers, body: form });
};

const errorOf = async (response: Response) => errorResponseSchema.parse(await response.json()).error;

describe('health', () => {
  it('answers without a token and says whether the AI is there', async () => {
    const { app } = makeApp();
    const without = await (await app.request('/health')).json();
    const withModel = await (await makeApp({}, { model: scripted() }).app.request('/health')).json();

    expect(without).toEqual({ status: 'ok', contractVersion: 1, ai: false });
    expect(withModel.ai).toBe(true);
  });

  it('answers any other route with a contract error', async () => {
    const response = await makeApp().app.request('/nope');

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('bad_request');
  });
});

describe('cors', () => {
  it('lets the plan app in and nobody else', async () => {
    const { app } = makeApp();
    const allowed = await app.request('/health', { headers: { Origin: 'http://localhost:8080' } });
    const blocked = await app.request('/health', { headers: { Origin: 'https://evil.example' } });

    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8080');
    expect(blocked.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers the preflight of the browser, with no token', async () => {
    const response = await makeApp().app.request('/v1/analyze', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:8080', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }
    });

    expect(response.status).toBeLessThan(300);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8080');
    expect(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('authorization');
  });

  it('allows no origin at all by default', async () => {
    const { app } = makeApp({ ALLOWED_ORIGINS: undefined });
    const response = await app.request('/health', { headers: { Origin: 'http://localhost:8080' } });

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('who can call', () => {
  it('needs a token', async () => {
    const response = await post(makeApp().app, '/v1/analyze', request(), {});

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe('unauthorized');
  });

  it('refuses a token that does not verify, without saying why', async () => {
    const response = await post(makeApp().app, '/v1/analyze', request(), { Authorization: 'Bearer forged' });

    expect(response.status).toBe(401);
  });

  it('refuses a role that is not allowed, and a token with no role', async () => {
    const { app } = makeApp();
    const editor = await post(app, '/v1/analyze', request(), { Authorization: 'Bearer editor' });
    const none = await post(app, '/v1/analyze', request(), { Authorization: 'Bearer norole' });

    expect(editor.status).toBe(403);
    expect((await errorOf(editor)).code).toBe('forbidden');
    expect(none.status).toBe(403);
  });

  it('lets any role in when it is set to *', async () => {
    const { app } = makeApp({ ALLOWED_ROLES: '*' });

    expect((await post(app, '/v1/analyze', request(), { Authorization: 'Bearer editor' })).status).toBe(200);
  });

  it('skips the token only in development and only when asked', async () => {
    expect((await post(makeApp({ ENVIRONMENT: 'development', ALLOW_INSECURE_DEV_AUTH: 'true' }).app, '/v1/analyze', request(), {})).status).toBe(200);
    expect((await post(makeApp({ ENVIRONMENT: 'development' }).app, '/v1/analyze', request(), {})).status).toBe(401);
    // the flag does nothing in production, nor when the environment is not set at all
    expect((await post(makeApp({ ENVIRONMENT: 'production', ALLOW_INSECURE_DEV_AUTH: 'true' }).app, '/v1/analyze', request(), {})).status).toBe(401);
    expect(readConfig({ ALLOW_INSECURE_DEV_AUTH: 'true' }).insecureDevAuth).toBe(false);
  });

  it('does not log what was sent, only who and how it went', async () => {
    const { app, logs } = makeApp();

    await post(app, '/v1/analyze', request({ prompt: 'secret request' }));

    expect(JSON.stringify(logs)).not.toContain('secret request');
    expect(JSON.stringify(logs)).not.toContain('Optional Island');
    expect(logs[logs.length - 1]).toMatchObject({ route: 'POST /v1/analyze', status: 200, uid: 'user-1' });
  });
});

describe('POST /v1/analyze', () => {
  it('answers with the rules and the sheet when there is no AI, and says so', async () => {
    const response = await post(makeApp().app, '/v1/analyze', request({ snapshot: { ...snapshot(), sheet: sheet() } }));
    const body = analyzeResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.operations.length).toBeGreaterThan(10);
    expect(body.operations.some(op => op.source === 'pdf')).toBe(true);
    expect(body.findings.some(finding => finding.id === 'ai-not-configured')).toBe(true);
    expect(body.trace).toEqual([]);
  });

  it('runs the agent on top of the rules', async () => {
    const plan = snapshot();
    const [a, b] = ['Optional Island at Kitchen', 'Optional Door at Primary Bath'].map(name => plan.items.find((item: any) => item.name === name).uid);
    const model = scripted(
      { text: '', toolCalls: [{ name: 'propose_exclusive_group', args: { uids: [a, b], reason: 'Test.', confidence: 'low' } }] },
      answer('Added one group.')
    );

    const response = await post(makeApp({}, { model }).app, '/v1/analyze', request({ prompt: 'check it' }));
    const body = analyzeResponseSchema.parse(await response.json());

    expect(body.assistantText).toBe('Added one group.');
    expect(body.operations.filter(op => op.source === 'ai')).toHaveLength(1);
    expect(body.trace).toEqual([{ tool: 'propose_exclusive_group', input: expect.anything(), ok: true, summary: expect.stringContaining('proposed') }]);
  });

  it('still answers with the rules when the model fails', async () => {
    const model = { generate: async () => { throw new Error('503 overloaded'); } };
    const response = await post(makeApp({}, { model }).app, '/v1/analyze', request());
    const body = analyzeResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.operations.length).toBeGreaterThan(5);
    expect(body.findings.some(finding => finding.id === 'ai-failed')).toBe(true);
  });

  it('says what is wrong with a request, and where', async () => {
    const { app } = makeApp();
    const notJson = await post(app, '/v1/analyze', 'not json');
    const version = await post(app, '/v1/analyze', { contractVersion: 2, snapshot: snapshot() });
    const missing = await post(app, '/v1/analyze', { contractVersion: 1 });
    const bad = snapshot();

    bad.items[0].kind = 'room';

    const invalid = await post(app, '/v1/analyze', { contractVersion: 1, snapshot: bad });

    expect([notJson.status, version.status, missing.status, invalid.status]).toEqual([400, 400, 400, 400]);
    expect((await errorOf(notJson)).message).toBe('The body is not JSON.');
    expect((await errorOf(version)).code).toBe('unsupported_contract_version');
    expect((await errorOf(missing)).message).toContain('snapshot');
    expect((await errorOf(invalid)).message).toContain('snapshot.items.0.kind');
  });

  it('refuses a plan that is too big', async () => {
    const huge = { contractVersion: 1, snapshot: snapshot(), prompt: '', padding: 'x'.repeat(5 * 1024 * 1024) };
    const response = await post(makeApp().app, '/v1/analyze', huge);

    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe('payload_too_large');
  });

  it('never leaks the detail of an unexpected failure', async () => {
    const broken = makeApp({}, { verify: async () => { throw new Error('database password is hunter2'); } });
    const response = await post(broken.app, '/v1/analyze', request());

    expect(response.status).toBe(500);
    expect(await errorOf(response)).toEqual({ code: 'internal', message: 'Something went wrong.' });
    expect(broken.logs.some(entry => String(entry.error).includes('hunter2'))).toBe(true);
  });

  it('keeps a failure of the verifier that is ours', async () => {
    const { app } = makeApp({}, { verify: async () => { throw new HttpError(401, 'unauthorized', 'The token is not valid.'); } });

    expect((await errorOf(await post(app, '/v1/analyze', request()))).message).toBe('The token is not valid.');
  });
});

describe('POST /v1/sheet', () => {
  const reader = async (): Promise<PlanSheet> => sheet();

  it('reads a pdf', async () => {
    const response = await upload(makeApp({}, { readSheet: reader }).app, pdf());
    const body = sheetResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.sheet.planName).toBe('Plan 2557');
    expect(body.sheet.options).toHaveLength(15);
  });

  it('hands the reader the bytes and the name', async () => {
    let seen: { bytes: number; name: string } | null = null;
    const { app } = makeApp({}, { readSheet: async (bytes, name) => { seen = { bytes: bytes.length, name }; return sheet(); } });

    await upload(app, pdf(1234));

    expect(seen).toEqual({ bytes: 1234, name: 'sheet.pdf' });
  });

  it('needs a pdf field, sent as multipart', async () => {
    const { app } = makeApp({}, { readSheet: reader });
    const json = await app.request('/v1/sheet', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
    const wrongField = await upload(app, pdf(), auth, 'file');

    expect(json.status).toBe(400);
    expect((await errorOf(json)).message).toContain('multipart/form-data');
    expect(wrongField.status).toBe(400);
    expect((await errorOf(wrongField)).message).toContain('"pdf" is missing');
  });

  it('checks that it really is a pdf, whatever the name says', async () => {
    const { app } = makeApp({}, { readSheet: reader });
    const response = await upload(app, new TextEncoder().encode('<html>not a pdf</html>'));

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe('The file is not a PDF.');
    expect((await upload(app, new Uint8Array(0))).status).toBe(400);
  });

  it('refuses a pdf over the limit', async () => {
    const { app } = makeApp({}, { readSheet: reader });
    const response = await upload(app, pdf(25 * 1024 * 1024 + 1));

    expect(response.status).toBe(413);
  });

  it('answers 502 when the model can not read it, and 503 when there is no AI', async () => {
    const failing = makeApp({}, { readSheet: async () => { throw new Error('Gemini request failed (429): Quota exceeded'); } });
    const bad = await upload(failing.app, pdf());

    expect(bad.status).toBe(502);
    expect(await errorOf(bad)).toMatchObject({ code: 'upstream_failed', message: expect.stringContaining('Quota exceeded') });

    const none = await upload(makeApp().app, pdf());

    expect(none.status).toBe(503);
  });

  it('needs the token like the rest', async () => {
    expect((await upload(makeApp({}, { readSheet: reader }).app, pdf(), {})).status).toBe(401);
  });
});
