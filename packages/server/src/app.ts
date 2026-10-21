/**
 * The HTTP API. Pure Web standard (Request/Response/fetch), so the same app
 * runs in a Cloudflare Worker and in the tests.
 *
 *   GET  /health
 *   POST /v1/analyze   json    -> operations
 *   POST /v1/sheet     pdf     -> plan sheet
 */

import {
  analyzeDeterministic,
  analyzeRequestSchema,
  analyzeResponseSchema,
  CONTRACT_VERSION,
  runAgent,
  sheetResponseSchema,
  type ModelClient,
  type PlanSheet
} from '@aivu/core';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { createVerifier, type AuthUser, type Verifier } from './auth';
import type { Config } from './env';
import { errorBody, HttpError } from './errors';

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

export interface Deps {
  config: Config;
  /** Defaults to verifying Firebase tokens for config.projectIds. */
  verify?: Verifier;
  /** null: no key, the rules and the sheet still work. */
  model: ModelClient | null;
  readSheet: ((pdf: Uint8Array, fileName: string) => Promise<PlanSheet>) | null;
  log?: (entry: Record<string, unknown>) => void;
}

type AppEnv = { Variables: { user: AuthUser } };

export function createApp(deps: Deps) {
  const { config } = deps;
  const verify = deps.verify ?? createVerifier({ projectIds: config.projectIds });
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)));
  const app = new Hono<AppEnv>();

  /* ------------------------------ cors ------------------------------ */
  app.use(
    '*',
    cors({
      // "*" lets any page call it (quick tests). The token travels in a header, not a cookie,
      // so a page that is not allowed still needs a valid Firebase token to get anything.
      origin: origin => (config.origins.indexOf('*') !== -1 || config.origins.indexOf(origin) !== -1 ? origin : ''),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600
    })
  );

  /* ---------------------------- request log ---------------------------- */
  app.use('*', async (c, next) => {
    const started = Date.now();

    await next();

    // what was sent is customer data: only who, where and how it went
    log({
      route: `${c.req.method} ${new URL(c.req.url).pathname}`,
      status: c.res.status,
      ms: Date.now() - started,
      uid: c.get('user')?.uid
    });
  });

  app.get('/health', c => c.json({ status: 'ok', contractVersion: CONTRACT_VERSION, ai: deps.model !== null }));

  /* ------------------------------ auth ------------------------------ */
  app.use('/v1/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      return next();
    }

    let user: AuthUser;

    if (config.insecureDevAuth) {
      // local development only, readConfig never turns it on in production
      user = { uid: 'dev', role: 'admin', projectId: 'dev' };
    } else {
      const header = c.req.header('Authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

      if (!token) {
        throw new HttpError(401, 'unauthorized', 'Send the Firebase token as "Authorization: Bearer <token>".');
      }

      user = await verify(token);

      if (config.roles && (!user.role || config.roles.indexOf(user.role) === -1)) {
        throw new HttpError(403, 'forbidden', 'Your role can not use AI Logic Assist.');
      }
    }

    c.set('user', user);

    return next();
  });

  /* ----------------------------- analyze ----------------------------- */
  app.post('/v1/analyze', async c => {
    const buffer = await c.req.arrayBuffer();

    if (buffer.byteLength > MAX_JSON_BYTES) {
      throw new HttpError(413, 'payload_too_large', 'The plan is larger than 5 MB.');
    }

    let body: unknown;

    try {
      body = JSON.parse(new TextDecoder().decode(buffer));
    } catch (error) {
      throw new HttpError(400, 'bad_request', 'The body is not JSON.');
    }

    const version = (body as { contractVersion?: unknown } | null)?.contractVersion;

    if (version !== CONTRACT_VERSION) {
      throw new HttpError(
        400,
        'unsupported_contract_version',
        `This backend speaks contract ${CONTRACT_VERSION}, the request says ${String(version)}.`
      );
    }

    const parsed = analyzeRequestSchema.safeParse(body);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];

      throw new HttpError(400, 'bad_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
    }

    const { snapshot, prompt } = parsed.data;

    if (!deps.model) {
      const baseline = analyzeDeterministic(snapshot);

      return c.json(
        analyzeResponseSchema.parse({
          contractVersion: CONTRACT_VERSION,
          operations: baseline.operations,
          findings: baseline.findings.concat({
            id: 'ai-not-configured',
            severity: 'info',
            message: 'The AI is not configured on this backend. Only the rules and the plan sheet were used.'
          }),
          assistantText: '',
          trace: []
        })
      );
    }

    const result = await runAgent({ snapshot, prompt, model: deps.model });

    return c.json(
      analyzeResponseSchema.parse({
        contractVersion: CONTRACT_VERSION,
        operations: result.operations,
        findings: result.findings,
        assistantText: result.assistantText,
        trace: result.trace
      })
    );
  });

  /* ------------------------------ sheet ------------------------------ */
  app.post('/v1/sheet', async c => {
    if (!deps.readSheet) {
      throw new HttpError(503, 'upstream_failed', 'The AI is not configured on this backend, it can not read PDFs.');
    }

    if (!(c.req.header('Content-Type') ?? '').startsWith('multipart/form-data')) {
      throw new HttpError(400, 'bad_request', 'Send the PDF as multipart/form-data, field "pdf".');
    }

    const declared = Number(c.req.header('Content-Length') ?? 0);

    if (declared > MAX_PDF_BYTES + 1024 * 1024) {
      throw new HttpError(413, 'payload_too_large', 'The PDF is larger than 25 MB.');
    }

    const form = await c.req.formData().catch(() => null);
    const file = form?.get('pdf');

    if (!file || typeof file === 'string') {
      throw new HttpError(400, 'bad_request', 'The field "pdf" is missing.');
    }

    if (file.size > MAX_PDF_BYTES) {
      throw new HttpError(413, 'payload_too_large', 'The PDF is larger than 25 MB.');
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    // "%PDF-": the name and the content type are whatever the client says
    if (bytes.length < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
      throw new HttpError(400, 'bad_request', 'The file is not a PDF.');
    }

    let sheet: PlanSheet;

    try {
      sheet = await deps.readSheet(bytes, file.name);
    } catch (error) {
      throw new HttpError(502, 'upstream_failed', error instanceof Error ? error.message : 'The PDF could not be read.');
    }

    return c.json(sheetResponseSchema.parse({ contractVersion: CONTRACT_VERSION, sheet }));
  });

  /* ----------------------------- errors ----------------------------- */
  app.notFound(c => c.json(errorBody('bad_request', 'No such route.'), 404));

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(errorBody(error.code, error.message), error.status as 400);
    }

    // not ours: keep the detail in the log, out of the answer
    log({ route: `${c.req.method} ${new URL(c.req.url).pathname}`, status: 500, error: error.message });

    return c.json(errorBody('internal', 'Something went wrong.'), 500);
  });

  return app;
}
