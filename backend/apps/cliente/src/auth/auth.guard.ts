import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildJwtConfig } from './jwt-config';
import {
  resolveCorrelationId,
  SecurityLogger,
  type CorrelationHeaders,
} from './security-logger';
import {
  SESSION_STORE,
  assertSession,
  type SessionStore,
} from './session-store';
import { verifyToken, type Principal } from './token-verifier';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
    private readonly security: SecurityLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers?: CorrelationHeaders & { authorization?: string };
      principal?: Principal;
    }>();
    const correlationId = resolveCorrelationId(request.headers);
    const header = request.headers?.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      this.security.emit('401', 'missing-token', correlationId);
      throw new UnauthorizedException();
    }

    let principal: Principal;
    try {
      principal = verifyToken(header.slice(7), buildJwtConfig(this.config));
    } catch {
      this.security.emit('401', 'invalid-token', correlationId);
      throw new UnauthorizedException();
    }

    try {
      await assertSession(principal, this.sessions);
    } catch (error) {
      if (error instanceof ForbiddenException) {
        this.security.emit('403', 'session-denied', correlationId);
      }
      throw error;
    }
    request.principal = principal;
    return true;
  }
}
