/**
 * What the Worker is given. Secrets (GEMINI_API_KEY) come from
 * `wrangler secret put` or .dev.vars, never from the repository.
 */
export interface Env {
  /** "production" unless it says otherwise: the safe default. */
  ENVIRONMENT?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  /** Only to point at a mock or a gateway. */
  GEMINI_BASE_URL?: string;
  /** Firebase projects whose users may call this, comma separated. */
  FIREBASE_PROJECT_IDS?: string;
  /** Browser origins allowed to call this, comma separated. */
  ALLOWED_ORIGINS?: string;
  /** Roles (claim `role` of the token) allowed, comma separated. "*" = any. */
  ALLOWED_ROLES?: string;
  /** Local development only: skips the token check. Ignored in production. */
  ALLOW_INSECURE_DEV_AUTH?: string;
}

export interface Config {
  environment: string;
  projectIds: string[];
  origins: string[];
  /** null = any role */
  roles: string[] | null;
  insecureDevAuth: boolean;
  geminiApiKey: string | null;
  geminiModel: string;
  geminiBaseUrl: string;
}

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0);

/** Same model and API the Firebase functions used. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

export function readConfig(env: Env): Config {
  const environment = env.ENVIRONMENT || 'production';
  const roles = env.ALLOWED_ROLES === undefined ? ['admin', 'manager', 'production'] : list(env.ALLOWED_ROLES);

  return {
    environment,
    projectIds: list(env.FIREBASE_PROJECT_IDS),
    origins: list(env.ALLOWED_ORIGINS),
    roles: roles.indexOf('*') !== -1 ? null : roles,
    insecureDevAuth: env.ALLOW_INSECURE_DEV_AUTH === 'true' && environment !== 'production',
    geminiApiKey: env.GEMINI_API_KEY || null,
    geminiModel: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    geminiBaseUrl: (env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '')
  };
}
