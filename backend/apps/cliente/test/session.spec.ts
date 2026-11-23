import { describe, expect, it } from 'vitest';
import {
  assertSession,
  createInMemorySessionStore,
} from '../src/auth/session-store';
import type { Principal } from '../src/auth/token-verifier';

const principal: Principal = {
  sub: 'u-1',
  role: 'admin',
  context: 'cliente',
  jti: 'jti-1',
  mfa: false,
};

describe('sessão: revogação e MFA explícitos (A2)', () => {
  it('whenJtiRevoked_thenSessionIsRejected', () => {
    const store = createInMemorySessionStore();
    store.revoke('jti-1');
    expect(() => assertSession(principal, store)).toThrow(/revogada/);
  });

  it('whenRoleRequiresMfaAndClaimMissing_thenSessionIsRejected', () => {
    const store = createInMemorySessionStore();
    expect(() =>
      assertSession({ ...principal, role: 'superadmin' }, store),
    ).toThrow(/MFA/);
  });

  it('whenMfaEnrolled_thenSessionIsAccepted', () => {
    const store = createInMemorySessionStore();
    store.enrollMfa('u-1');
    expect(() =>
      assertSession({ ...principal, mfa: true }, store),
    ).not.toThrow();
  });

  it('whenFreshSession_thenSessionIsAccepted', () => {
    expect(() => assertSession(principal, createInMemorySessionStore())).not.toThrow();
  });
});
