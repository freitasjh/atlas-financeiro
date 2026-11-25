import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { resolveCorrelationId, SecurityLogger } from './security-logger';
import { ROLES_KEY } from './roles.decorator';
import type { Principal } from './token-verifier';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly security: SecurityLogger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;

    const request = context.switchToHttp().getRequest<{
      headers?: Parameters<typeof resolveCorrelationId>[0];
      principal?: Principal;
    }>();
    const principal = request.principal;
    if (!principal || !roles.includes(principal.role)) {
      this.security.emit(
        '403',
        'role-denied',
        resolveCorrelationId(request.headers),
      );
      throw new ForbiddenException();
    }
    return true;
  }
}
