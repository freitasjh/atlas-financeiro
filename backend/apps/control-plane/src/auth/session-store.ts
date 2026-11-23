import { ForbiddenException } from '@nestjs/common';
import type { Principal } from './token-verifier';

/** A2: revogação e MFA explícitos. Adapter em memória = skeleton (sem DB). */
export interface SessionStore {
  isRevoked(jti: string | undefined): boolean;
  revoke(jti: string): void;
  hasMfa(sub: string): boolean;
  enrollMfa(sub: string): void;
}

export const SESSION_STORE = 'SESSION_STORE';
export const MFA_REQUIRED_ROLES = ['superadmin'] as const;

export function createInMemorySessionStore(): SessionStore {
  const revoked = new Set<string>();
  const enrolled = new Set<string>();
  return {
    isRevoked: (jti) => (jti ? revoked.has(jti) : false),
    revoke: (jti) => {
      revoked.add(jti);
    },
    hasMfa: (sub) => enrolled.has(sub),
    enrollMfa: (sub) => {
      enrolled.add(sub);
    },
  };
}

export function assertSession(
  principal: Principal,
  sessions: SessionStore,
): void {
  if (sessions.isRevoked(principal.jti)) {
    throw new ForbiddenException('sessão revogada');
  }
  if (principal.mfa === true && !sessions.hasMfa(principal.sub)) {
    throw new ForbiddenException('MFA não concluído');
  }
  if (
    (MFA_REQUIRED_ROLES as readonly string[]).includes(principal.role) &&
    !principal.mfa
  ) {
    throw new ForbiddenException('MFA obrigatório para este papel');
  }
}
