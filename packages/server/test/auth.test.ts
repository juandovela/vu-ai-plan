import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { createVerifier } from '../src/auth';
import { HttpError } from '../src/errors';

const PROJECT = 'vu-stage';
const OTHER = 'vu-kb';

let privateKey: CryptoKey;
let getKey: ReturnType<typeof createLocalJWKSet>;
let strangerKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

  privateKey = pair.privateKey as CryptoKey;
  getKey = createLocalJWKSet({ keys: [jwk] });
  strangerKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;
});

const sign = (claims: Record<string, unknown> = {}, options: { key?: CryptoKey; project?: string; expires?: string | number; issuer?: string; kid?: string } = {}) =>
  new SignJWT({ role: 'admin', email: 'a@b.com', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'k1' })
    .setSubject('uid-1')
    .setIssuedAt()
    .setIssuer(options.issuer ?? `https://securetoken.google.com/${options.project ?? PROJECT}`)
    .setAudience(options.project ?? PROJECT)
    .setExpirationTime(options.expires ?? '1h')
    .sign(options.key ?? privateKey);

const verifier = (projectIds = [PROJECT]) => createVerifier({ projectIds, getKey });
const rejected = async (token: string, projectIds?: string[]) => {
  const error = await verifier(projectIds)(token).catch(e => e);

  expect(error).toBeInstanceOf(HttpError);
  expect(error.status).toBe(401);

  return error as HttpError;
};

describe('firebase token verification', () => {
  it('accepts a good token and reads who it is', async () => {
    expect(await verifier()(await sign())).toEqual({ uid: 'uid-1', email: 'a@b.com', role: 'admin', projectId: PROJECT });
  });

  it('accepts a user of any of the configured projects', async () => {
    expect((await verifier([PROJECT, OTHER])(await sign({}, { project: OTHER }))).projectId).toBe(OTHER);
  });

  it('refuses a project that is not ours', async () => {
    await rejected(await sign({}, { project: 'someone-elses' }));
  });

  it('refuses an expired token', async () => {
    await rejected(await sign({}, { expires: Math.floor(Date.now() / 1000) - 60 }));
  });

  it('refuses a token signed with another key', async () => {
    await rejected(await sign({}, { key: strangerKey }));
  });

  it('refuses a key id it does not know', async () => {
    await rejected(await sign({}, { kid: 'unknown' }));
  });

  it('refuses a token whose issuer is another project than its audience', async () => {
    await rejected(await sign({}, { project: PROJECT, issuer: `https://securetoken.google.com/${OTHER}` }), [PROJECT, OTHER]);
  });

  it('refuses a token without alg, and one signed with a shared secret', async () => {
    await rejected(new UnsecuredJWT({ role: 'admin' }).setSubject('x').setIssuer(`https://securetoken.google.com/${PROJECT}`).setAudience(PROJECT).encode());
    await rejected(
      await new SignJWT({ role: 'admin' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('x')
        .setIssuer(`https://securetoken.google.com/${PROJECT}`)
        .setAudience(PROJECT)
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('secret'))
    );
  });

  it('refuses garbage', async () => {
    await rejected('');
    await rejected('not.a.jwt');
    await rejected('a.b.c');
  });

  it('refuses everybody when no project is configured', async () => {
    const error = await rejected(await sign(), []);

    expect(error.message).toContain('no Firebase project');
  });

  it('never says why a token failed', async () => {
    const reasons = await Promise.all([rejected(await sign({}, { project: 'x' })), rejected(await sign({}, { key: strangerKey })), rejected('garbage')]);

    expect(new Set(reasons.map(error => error.message))).toEqual(new Set(['The token is not valid.']));
  });

  it('tells a bad token from Google not answering', async () => {
    const token = await sign();
    const failing = async (error: unknown): Promise<HttpError> => {
      try {
        await createVerifier({ projectIds: [PROJECT], getKey: async () => { throw error; } })(token);
      } catch (thrown) {
        return thrown as HttpError;
      }

      throw new Error('the verifier should have failed');
    };

    // nothing the user can fix: a retry may work
    for (const error of [new TypeError('fetch failed'), new errors.JWKSTimeout(), new errors.JWKSInvalid('bad keys')]) {
      const result = await failing(error);

      expect(result).toBeInstanceOf(HttpError);
      expect(result.status).toBe(503);
      expect(result.code).toBe('upstream_failed');
    }

    // a key that does not match is a token problem
    expect((await failing(new errors.JWKSNoMatchingKey())).status).toBe(401);
  });

  it('leaves out a role the token does not carry', async () => {
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('uid-2').setIssuer(`https://securetoken.google.com/${PROJECT}`).setAudience(PROJECT).setExpirationTime('1h').sign(privateKey);

    expect(await verifier()(token)).toMatchObject({ uid: 'uid-2', role: undefined });
  });
});
