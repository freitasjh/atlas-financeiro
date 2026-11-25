import { describe, expect, it } from 'vitest';
import {
  verifyToken,
  validateJwtConfig,
  signToken as emitToken,
} from '../src/auth/token-verifier';
import { configureEnv, signToken, unsignedToken } from './support/setup';

describe('JWT alg fixo no app cliente (S1)', () => {
  const env = configureEnv();
  const config = {
    algorithm: 'ES256' as const,
    issuer: env.issuer,
    audience: env.audience,
    privateKey: env.privateKey,
    context: 'cliente' as const,
  };

  it('whenValidEs256Token_thenPrincipalIsReturned', () => {
    const token = signToken(env, { sub: 'u-1', role: 'admin' });
    const principal = verifyToken(token, config);
    expect(principal.role).toBe('admin');
    expect(principal.context).toBe('cliente');
  });

  it('whenAlgNone_thenTokenIsRejected', () => {
    expect(() => verifyToken(unsignedToken({ sub: 'u-1', role: 'admin' }), config)).toThrow();
  });

  it('whenAlgHs256WithSameLengthSecret_thenTokenIsRejected', () => {
    const token = signToken(env, { sub: 'u-1', role: 'admin' }, { algorithm: 'HS256' });
    expect(() => verifyToken(token, config)).toThrow();
  });

  it('whenIssuerDiffers_thenTokenIsRejected', () => {
    const token = signToken(env, { sub: 'u-1', role: 'admin' }, {
      issuer: 'https://issuer.test/control-plane',
      audience: 'atlas-control-plane',
    });
    expect(() => verifyToken(token, config)).toThrow();
  });

  it('whenAudienceDiffers_thenTokenIsRejected', () => {
    const token = signToken(env, { sub: 'u-1', role: 'admin' }, {
      audience: 'atlas-control-plane',
    });
    expect(() => verifyToken(token, config)).toThrow();
  });

  it('whenHs256WithShortSecret_thenConfigValidationFails', () => {
    expect(() =>
      validateJwtConfig({
        algorithm: 'HS256',
        issuer: env.issuer,
        audience: env.audience,
        secret: 'too-short',
      }),
    ).toThrow(/256 bits/);
  });

  it('whenEs256KeyConfigured_thenConfigValidationPasses', () => {
    expect(() => validateJwtConfig(config)).not.toThrow();
  });

  it('whenTokenEmitted_thenClaimsAndEs256MatchConfig', () => {
    const token = emitToken(
      { sub: 'u-1', role: 'admin', jti: 'jti-1', mfa: true },
      config,
    );
    const decode = (part: string): Record<string, unknown> =>
      JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const [headerPart, payloadPart] = token.split('.');
    const header = decode(headerPart);
    const payload = decode(payloadPart);

    expect(header.alg).toBe('ES256');
    expect(payload).toMatchObject({
      iss: env.issuer,
      aud: env.audience,
      context: 'cliente',
      sub: 'u-1',
      role: 'admin',
      jti: 'jti-1',
      mfa: true,
    });
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect(Number(payload.exp)).toBeGreaterThan(Number(payload.iat));
    expect(verifyToken(token, config).role).toBe('admin');
  });

  it('whenControlPlaneAudience_thenVerificationRejects', () => {
    const token = emitToken(
      { sub: 'u-op', role: 'admin' },
      { ...config, audience: 'atlas-control-plane' },
    );
    expect(() => verifyToken(token, config)).toThrow();
  });

  it('whenContextClaimMismatch_thenVerificationRejects', () => {
    // aud/iss corretos; só o claim context divergia e hoje era ignorado (F-3).
    const token = emitToken(
      { sub: 'u-op', role: 'admin' },
      { ...config, context: 'control-plane' },
    );
    let message = '';
    try {
      verifyToken(token, config);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('token inválido');
    expect(message).not.toContain('contexto inválido');
  });
});
