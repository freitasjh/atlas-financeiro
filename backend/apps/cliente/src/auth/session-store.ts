import { ForbiddenException } from '@nestjs/common';
import type { Principal } from './token-verifier';

/** A2/AUTH-08: revogação e MFA explícitos, assíncronos e DB-backed em produção. */
export interface SessionStore {
  isRevoked(sub: string, jti: string | undefined): Promise<boolean>;
  revoke(sub: string, jti: string, motivo?: string): Promise<void>;
  hasMfa(sub: string): Promise<boolean>;
  enrollMfa(sub: string): Promise<void>;
}

export const SESSION_STORE = 'SESSION_STORE';
export const MFA_REQUIRED_ROLES = ['superadmin'] as const;

/** Somente para testes: em produção a fábrica recusa o boot. */
export function createInMemorySessionStore(): SessionStore {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('store de sessão em memória proibido em produção');
  }
  const revoked = new Set<string>();
  const enrolled = new Set<string>();
  return {
    isRevoked: async (_sub, jti) => (jti ? revoked.has(jti) : false),
    revoke: async (_sub, jti) => {
      revoked.add(jti);
    },
    hasMfa: async (sub) => enrolled.has(sub),
    enrollMfa: async (sub) => {
      enrolled.add(sub);
    },
  };
}

export async function assertSession(
  principal: Principal,
  sessions: SessionStore,
): Promise<void> {
  if (await sessions.isRevoked(principal.sub, principal.jti)) {
    throw new ForbiddenException('sessão revogada');
  }
  if (principal.mfa === true && !(await sessions.hasMfa(principal.sub))) {
    throw new ForbiddenException('MFA não concluído');
  }
  if (
    (MFA_REQUIRED_ROLES as readonly string[]).includes(principal.role) &&
    !principal.mfa
  ) {
    throw new ForbiddenException('MFA obrigatório para este papel');
  }
}
