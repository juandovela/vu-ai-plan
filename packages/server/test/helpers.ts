import type { ModelClient, ModelResponse } from '@aivu/core';

import { createApp, type Deps } from '../src/app';
import type { AuthUser } from '../src/auth';
import { readConfig, type Env } from '../src/env';
import { HttpError } from '../src/errors';

export const user: AuthUser = { uid: 'user-1', role: 'admin', projectId: 'test-project' };

/** An app with a verifier that accepts "Bearer good" and refuses anything else. */
export function makeApp(env: Env = {}, overrides: Partial<Deps> = {}) {
  const logs: Array<Record<string, unknown>> = [];
  const app = createApp({
    config: readConfig({ ENVIRONMENT: 'production', ALLOWED_ORIGINS: 'http://localhost:8080', ...env }),
    verify: async token => {
      if (token === 'good') return user;
      if (token === 'editor') return { ...user, role: 'editor' };
      if (token === 'norole') return { ...user, role: undefined };
      throw new HttpError(401, 'unauthorized', 'The token is not valid.');
    },
    model: null,
    readSheet: null,
    log: entry => logs.push(entry),
    ...overrides
  });

  return { app, logs };
}

export const auth = { Authorization: 'Bearer good' };

export const answer = (text: string): ModelResponse => ({ text, toolCalls: [] });

export const scripted = (...steps: ModelResponse[]): ModelClient => {
  let index = 0;

  return { generate: async () => steps[index++] ?? answer('done') };
};

export const pdf = (size = 200) => {
  const bytes = new Uint8Array(size);

  bytes.set(new TextEncoder().encode('%PDF-1.4\n'));

  return bytes;
};
