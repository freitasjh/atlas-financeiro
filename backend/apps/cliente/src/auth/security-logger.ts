import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

/** NFR-05: payload fechado — nunca token, senha, corpo, URL ou PII. */
export const SECURITY_CONTEXT = 'cliente' as const;
export const CORRELATION_HEADER = 'x-correlation-id';

export type SecurityEvent =
  | 'login-success'
  | 'login-failure'
  | '401'
  | '403'
  | 'refresh-reuse'
  | 'family-revoked';

export type SecurityReason =
  | 'authenticated'
  | 'invalid-credentials'
  | 'invalid-input'
  | 'rate-limited'
  | 'missing-token'
  | 'invalid-token'
  | 'session-denied'
  | 'role-denied'
  | 'refresh-reused'
  | 'family-revoked';

export interface SecurityLogPayload {
  readonly event: SecurityEvent;
  readonly correlationId: string;
  readonly context: 'cliente';
  readonly reason: SecurityReason;
}

export interface CorrelationHeaders {
  readonly [CORRELATION_HEADER]?: string | string[] | undefined;
}

/** Cabeçalho do cliente é aceito só se não carregar PII/token (sem @, ponto, espaço ou '/'). */
const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export function resolveCorrelationId(headers?: CorrelationHeaders): string {
  const supplied = headers?.[CORRELATION_HEADER];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  return typeof value === 'string' && CORRELATION_PATTERN.test(value) ? value : randomUUID();
}

@Injectable()
export class SecurityLogger {
  private readonly logger = new Logger(SecurityLogger.name);

  emit(event: SecurityEvent, reason: SecurityReason, correlationId: string): void {
    const payload: SecurityLogPayload = {
      event,
      correlationId: CORRELATION_PATTERN.test(correlationId) ? correlationId : randomUUID(),
      context: SECURITY_CONTEXT,
      reason,
    };
    this.logger.log(JSON.stringify(payload));
  }
}
