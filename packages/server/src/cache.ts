/**
 * Answers kept by what was asked, so the same plan sheet or the same plan with
 * the same question does not go to the model twice.
 *
 * The key always carries a fingerprint of the model, the prompts and the
 * contract: change any of them and the old answers are simply not found.
 * The hash of a PDF is always computed here, never taken from the client, so
 * nobody can store an answer under the hash of a file they did not send.
 */

/** The part of a Cloudflare KV namespace this uses (and what the tests fake). */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface ResultCache {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
}

/**
 * Bump it when the rules or the tools change what an answer is for the same
 * question: it is part of every key, so the answers kept before are not found.
 */
export const CACHE_VERSION = 1;

/** KV needs at least 60 seconds; a plan sheet does not change, an analysis may be worth redoing. */
export const SHEET_TTL_SECONDS = 60 * 60 * 24 * 30;
export const ANALYSIS_TTL_SECONDS = 60 * 60 * 24 * 7;

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;

  return toHex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/** Same JSON, same text: keys in order, so the order the client wrote them in does not matter. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(item => canonicalJson(item === undefined ? null : item)).join(',') + ']';
  }

  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;

    return (
      '{' +
      Object.keys(object)
        .filter(key => object[key] !== undefined)
        .sort()
        .map(key => JSON.stringify(key) + ':' + canonicalJson(object[key]))
        .join(',') +
      '}'
    );
  }

  return JSON.stringify(value);
}

export const isSha256 = (value: string) => /^[0-9a-f]{64}$/.test(value);

/** What the answers depend on besides the question. */
export const fingerprintOf = (parts: string[]) => sha256Hex(parts.join('\u0000'));

export function kvCache(kv: KVLike, ttlSeconds: { sheet: number; analysis: number } = {
  sheet: SHEET_TTL_SECONDS,
  analysis: ANALYSIS_TTL_SECONDS
}): ResultCache {
  return {
    async get<T>(key: string) {
      try {
        const text = await kv.get(key);

        return text === null ? null : (JSON.parse(text) as T);
      } catch (error) {
        // a cache that fails is a cache that missed
        return null;
      }
    },

    async put(key: string, value: unknown) {
      try {
        await kv.put(key, JSON.stringify(value), {
          expirationTtl: key.startsWith('sheet:') ? ttlSeconds.sheet : ttlSeconds.analysis
        });
      } catch (error) {
        // the answer is already computed: not being able to keep it is not an error
      }
    }
  };
}

/** For the tests. */
export function memoryCache(): ResultCache & { entries: Map<string, string> } {
  const entries = new Map<string, string>();

  return {
    entries,
    async get<T>(key: string) {
      const text = entries.get(key);

      return text === undefined ? null : (JSON.parse(text) as T);
    },
    async put(key: string, value: unknown) {
      entries.set(key, JSON.stringify(value));
    }
  };
}
