import { describe, expect, it } from 'vitest';
import { verifyToken, validateJwtConfig } from '../src/auth/token-verifier';
import { configureEnv, signToken, unsignedToken } from './support/setup';

describe('JWT alg fixo no app control-plane (S1)', () => {
  const env = configureEnv();
  const config = {
    algorithm: 'ES256' as const,
    issuer: env.issuer,
    audience: env.audience,
    privateKey: env.privateKey,
  };

  it('whenValidEs256Token_thenPrincipalIsReturned', () => {
    const token = signToken(env, { sub: 'u-1', role: 'admin' });
    const principal = verifyToken(token, config);
    expect(principal.role).toBe('admin');
    expect(principal.context).toBe('control-plane');
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
      issuer: 'https://issuer.test/cliente',
      audience: 'atlas-cliente',
    });
    expect(() => verifyToken(token, config)).toThrow();
  });

  it('whenAudienceDiffers_thenTokenIsRejected', () => {
    const token = signToken(env, { sub: 'u-1', role: 'admin' }, {
      audience: 'atlas-cliente',
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
});
