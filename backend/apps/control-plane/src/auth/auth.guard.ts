import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildJwtConfig } from './jwt-config';
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
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      principal?: Principal;
    }>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }

    let principal: Principal;
    try {
      principal = verifyToken(header.slice(7), buildJwtConfig(this.config));
    } catch {
      throw new UnauthorizedException();
    }

    assertSession(principal, this.sessions);
    request.principal = principal;
    return true;
  }
}
