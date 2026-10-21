/**
 * Verifies the Firebase ID token the app sends (RS256 JWT signed by Google).
 *
 * Checks signature, expiry, issuer, audience, and that the project is one of
 * ours. Keys come from Google and are cached by jose between requests.
 */

import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

import { HttpError } from './errors';

const GOOGLE_KEYS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export interface AuthUser {
  uid: string;
  email?: string;
  role?: string;
  projectId: string;
}

let remoteKeys: JWTVerifyGetKey | null = null;

const googleKeys = (): JWTVerifyGetKey => (remoteKeys ??= createRemoteJWKSet(new URL(GOOGLE_KEYS)));

export type Verifier = (token: string) => Promise<AuthUser>;

// never say why: it only helps whoever is forging a token
const invalid = () => new HttpError(401, 'unauthorized', 'The token is not valid.');

/**
 * A bad token is the user's problem (401). Not being able to get Google's keys
 * is ours, and a retry can fix it (503): do not tell the user their session
 * failed when Google did not answer.
 */
function classify(error: unknown): HttpError {
  const infrastructure =
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    !(error instanceof errors.JOSEError);

  return infrastructure
    ? new HttpError(503, 'upstream_failed', 'The token could not be checked right now, try again.')
    : invalid();
}

export function createVerifier(options: { projectIds: string[]; getKey?: JWTVerifyGetKey }): Verifier {
  return async token => {
    if (options.projectIds.length === 0) {
      // fail closed: no project configured means nobody gets in
      throw new HttpError(401, 'unauthorized', 'The backend has no Firebase project configured.');
    }

    let payload: JWTPayload;

    try {
      ({ payload } = await jwtVerify(token, options.getKey ?? googleKeys(), {
        algorithms: ['RS256'],
        audience: options.projectIds,
        issuer: options.projectIds.map(id => `https://securetoken.google.com/${id}`)
      }));
    } catch (error) {
      throw classify(error);
    }

    const projectId = String(payload.aud);

    // the token has to be of the project it says it is of
    if (payload.iss !== `https://securetoken.google.com/${projectId}` || typeof payload.sub !== 'string' || !payload.sub) {
      throw invalid();
    }

    return {
      uid: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      role: typeof payload.role === 'string' ? payload.role : undefined,
      projectId
    };
  };
}
