import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  loginRequest,
  refreshRequest,
  type LoginRequest,
  type RefreshRequest,
} from '@shared/v1';
import { CLIENTE_DB, type NamedDatabase } from '../database/database.tokens';
import { withClienteAppRole } from './cliente-app-role';
import { buildJwtConfig } from './jwt-config';
import {
  LOGIN_THROTTLE,
  ThrottledException,
  withLoginThrottle,
  type LoginThrottle,
} from './login-throttle';
import { hashPassword, needsRehash, verifyPassword } from './password-hasher';
import { RefreshError, RefreshService, type IssuedRefresh } from './refresh-service';
import {
  CORRELATION_HEADER,
  resolveCorrelationId,
  type CorrelationHeaders,
  SecurityLogger,
} from './security-logger';
import { ACCESS_TOKEN_TTL_SECONDS, signToken } from './token-verifier';

type HttpResponse = {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
};

// O pipe global converte issues do Zod em mensagens; o envelope v1 exige `field`.
function fieldOf(messages: string[]): string {
  const text = messages.join(' ');
  const path = /^([A-Za-z_][\w.-]*):/.exec(text);
  if (path) return path[1];
  const key = /Unrecognized key: "([^"]+)"/.exec(text);
  return key?.[1] ?? 'body';
}

@Catch(ThrottledException)
class ThrottleFilter implements ExceptionFilter {
  catch(exception: ThrottledException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    response.status(exception.status).json({
      statusCode: exception.status,
      message: exception.message,
    });
  }
}

@Catch(BadRequestException)
class FieldErrorFilter implements ExceptionFilter {
  constructor(private readonly security: SecurityLogger) {}

  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<{ url?: string; headers?: CorrelationHeaders }>();
    if (request.url?.startsWith('/auth/login')) {
      this.security.emit(
        'login-failure',
        'invalid-input',
        resolveCorrelationId(request.headers),
      );
    }
    const raw = (exception.getResponse() as { message?: unknown }).message;
    const messages = Array.isArray(raw)
      ? raw.map((item) => String(item))
      : [String(raw ?? 'Requisição inválida')];
    ctx.getResponse<HttpResponse>().status(400).json({
      version: 'v1',
      field: fieldOf(messages),
      message: messages.join(' '),
    });
  }
}

/** Rotas públicas: nenhum AuthGuard/RolesGuard nesta classe. */
@Controller('auth')
@UseFilters(ThrottleFilter, FieldErrorFilter)
export class PublicAuthController {
  constructor(
    private readonly config: ConfigService,
    @Inject(CLIENTE_DB) private readonly db: NamedDatabase,
    @Inject(LOGIN_THROTTLE) private readonly throttle: LoginThrottle,
    private readonly refresh: RefreshService,
    private readonly security: SecurityLogger,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body({ schema: loginRequest }) body: LoginRequest,
    @Req() request: { ip?: string; headers?: CorrelationHeaders },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<unknown> {
    const correlationId = resolveCorrelationId(request.headers);
    response.setHeader(CORRELATION_HEADER, correlationId);
    try {
      // Throttle antes de qualquer scrypt; ticket cobre a requisição inteira.
      const issued = await withLoginThrottle(this.throttle, request.ip ?? 'desconhecido', async () => {
        const sub = await withClienteAppRole(this.db.pool, undefined, async (client) => {
          const result = await client.query('SELECT cliente.sub_por_email($1) AS sub', [body.email]);
          const value: unknown = result.rows[0]?.sub;
          return typeof value === 'string' ? value : undefined;
        });
        if (sub === undefined) throw new UnauthorizedException();

        const credential = await withClienteAppRole(this.db.pool, sub, async (client) => {
          const result = await client.query(
            [
              'SELECT c.password_hash, c.role, COALESCE(m.enrolled, false) AS mfa',
              ' FROM cliente.credenciais c LEFT JOIN cliente.mfa m ON m.sub = c.sub',
              ' WHERE c.sub = $1',
            ].join(' '),
            [sub],
          );
          return result.rows[0] as
            | { password_hash: string; role: string; mfa: boolean }
            | undefined;
        });
        if (credential === undefined) throw new UnauthorizedException();

        let valid = false;
        try {
          valid = await verifyPassword(body.password, credential.password_hash);
        } catch {
          valid = false; // hash corrompido não é credencial válida; sem PII no erro.
        }
        if (!valid) throw new UnauthorizedException();

        if (needsRehash(credential.password_hash)) {
          const updated = await hashPassword(body.password);
          await withClienteAppRole(this.db.pool, sub, async (client) => {
            await client.query('UPDATE cliente.credenciais SET password_hash = $1 WHERE sub = $2', [
              updated,
              sub,
            ]);
          });
        }

        return this.refresh.issue(sub, credential.role, credential.mfa === true);
      });
      this.security.emit('login-success', 'authenticated', correlationId);
      return this.envelope(issued);
    } catch (error) {
      if (error instanceof ThrottledException) {
        this.security.emit('login-failure', 'rate-limited', correlationId);
      } else if (error instanceof UnauthorizedException) {
        this.security.emit('login-failure', 'invalid-credentials', correlationId);
      }
      throw error;
    }
  }

  @Post('refresh')
  @HttpCode(200)
  async refreshSession(
    @Body({ schema: refreshRequest }) body: RefreshRequest,
    @Req() request: { headers?: CorrelationHeaders },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<unknown> {
    const correlationId = resolveCorrelationId(request.headers);
    response.setHeader(CORRELATION_HEADER, correlationId);
    let issued: IssuedRefresh;
    try {
      issued = await this.refresh.rotate(body.refreshToken, correlationId);
    } catch (error) {
      if (error instanceof RefreshError) throw new UnauthorizedException();
      throw error; // falha de infra não é disfarçada de 401.
    }
    return this.envelope(issued);
  }

  private envelope(issued: IssuedRefresh) {
    return {
      version: 'v1' as const,
      data: {
        accessToken: signToken(
          {
            sub: issued.sub,
            role: issued.role,
            jti: issued.jti,
            mfa: issued.mfa,
          },
          buildJwtConfig(this.config),
        ),
        refreshToken: issued.refreshToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      },
    };
  }
}
