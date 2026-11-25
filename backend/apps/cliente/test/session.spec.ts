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
  it('whenJtiRevoked_thenSessionIsRejected', async () => {
    const store = createInMemorySessionStore();
    await store.revoke('u-1', 'jti-1');
    await expect(assertSession(principal, store)).rejects.toThrow(/revogada/);
  });

  it('whenRoleRequiresMfaAndClaimMissing_thenSessionIsRejected', async () => {
    const store = createInMemorySessionStore();
    await expect(
      assertSession({ ...principal, role: 'superadmin' }, store),
    ).rejects.toThrow(/MFA/);
  });

  it('whenMfaEnrolled_thenSessionIsAccepted', async () => {
    const store = createInMemorySessionStore();
    await store.enrollMfa('u-1');
    await expect(assertSession({ ...principal, mfa: true }, store)).resolves.toBeUndefined();
  });

  it('whenFreshSession_thenSessionIsAccepted', async () => {
    await expect(assertSession(principal, createInMemorySessionStore())).resolves.toBeUndefined();
  });
});
