import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { withClienteAppRole } from '../src/auth/cliente-app-role';
import {
  LOGIN_THROTTLE,
  ThrottledException,
  createLoginThrottle,
  withLoginThrottle,
  type LoginThrottle,
} from '../src/auth/login-throttle';
import { hashPassword } from '../src/auth/password-hasher';
import { hashRefreshToken } from '../src/auth/refresh-service';
import { SESSION_STORE, createInMemorySessionStore } from '../src/auth/session-store';
import { CLIENTE_DB, type NamedDatabase } from '../src/database/database.tokens';
import { loadB2Env } from './support/b2-gate';
import { applyClienteMigration } from './support/migrate';
import { configureEnv, createTestApp, signToken, type TestEnv } from './support/setup';

const GOLDEN = path.resolve(process.cwd(), 'apps/cliente/test/golden/auth-before.fixture.json');
const PREFIX = `auth05-${randomUUID().slice(0, 8)}`;

interface AuthRoute {
  method: string;
  path: string;
}

/** Express expõe as rotas registradas; usamos para provar o total exato sob /auth. */
function authRoutes(app: INestApplication): AuthRoute[] {
  const instance = app.getHttpAdapter().getInstance() as {
    router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
    _router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
  };
  const stack = (instance.router ?? instance._router)?.stack ?? [];
  const routes: AuthRoute[] = [];
  for (const layer of stack) {
    const route = layer.route;
    if (!route?.path.startsWith('/auth')) continue;
    for (const method of Object.keys(route.methods)) {
      routes.push({ method: method.toUpperCase(), path: route.path });
    }
  }
  return routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

describe('AUTH-05 — rotas exatas de auth no app cliente', () => {
  let app: INestApplication;
  let env: TestEnv;
  let pool: Pool;
  let named: NamedDatabase;

  beforeAll(async () => {
    env = configureEnv();
    const b2 = loadB2Env();
    expect(b2.CLIENTE_DATABASE_URL, 'CLIENTE_DATABASE_URL ausente (B2)').toBeTruthy();
    pool = new Pool({ connectionString: b2.CLIENTE_DATABASE_URL });
    await applyClienteMigration(pool);
    named = {
      token: CLIENTE_DB,
      schema: 'cliente',
      role: 'cliente_app_role',
      url: '',
      pool,
      probe: vi.fn(async () => true),
    } as unknown as NamedDatabase;
    app = await createTestApp(AppModule, CLIENTE_DB, named, [
      { token: SESSION_STORE, value: createInMemorySessionStore() },
    ]);
  });

  /** App com throttle novo por caso: a chave é o socket address real, sem proxy. */
  async function createIsolatedApp(): Promise<INestApplication> {
    return createTestApp(AppModule, CLIENTE_DB, named, [
      { token: SESSION_STORE, value: createInMemorySessionStore() },
      { token: LOGIN_THROTTLE, value: createLoginThrottle() },
    ]);
  }

  afterAll(async () => {
    await app?.close();
    if (pool) {
      await pool.query('DELETE FROM cliente.revogacoes WHERE sub LIKE $1', [`${PREFIX}%`]);
      await pool.query('DELETE FROM cliente.refresh_tokens WHERE sub LIKE $1', [`${PREFIX}%`]);
      await pool.query('DELETE FROM cliente.credenciais WHERE sub LIKE $1', [`${PREFIX}%`]);
      await pool.end();
    }
  });

  async function seed(sub: string, password: string): Promise<void> {
    const stored = await hashPassword(password);
    await withClienteAppRole(pool, sub, async (client) => {
      await client.query(
        'INSERT INTO cliente.credenciais (sub, email, password_hash, role) VALUES ($1, $2, $3, $4)',
        [sub, `${sub}@example.test`, stored, 'admin'],
      );
    });
  }

  async function seedRefresh(sub: string, opaque: string): Promise<string> {
    const family = `${PREFIX}-family-${sub}`;
    await withClienteAppRole(pool, sub, async (client) => {
      await client.query(
        'INSERT INTO cliente.credenciais (sub, email, password_hash, role) VALUES ($1, $2, $3, $4)',
        [sub, `${sub}@example.test`, 'scrypt$ln=17,r=8,p=1$00$00', 'admin'],
      );
      await client.query(
        [
          'INSERT INTO cliente.refresh_tokens',
          ' (sub, token_hash, family_id, jti, estado, expira_em)',
          " VALUES ($1, $2, $3, $4, 'ativo', now() + interval '1 hour')",
        ].join(' '),
        [sub, hashRefreshToken(opaque), family, `jti-${sub}`],
      );
    });
    return family;
  }

  it('whenRoutesEnumerated_thenExactlyThreeAuthRoutes', () => {
    expect(authRoutes(app)).toEqual([
      { method: 'GET', path: '/auth/check' },
      { method: 'POST', path: '/auth/login' },
      { method: 'POST', path: '/auth/refresh' },
    ]);
    expect(authRoutes(app).some((route) => route.path === '/auth/sign-in')).toBe(false);
    expect(authRoutes(app).some((route) => ['/cadastro', '/logout'].includes(route.path))).toBe(false);
  });

  it('whenPublicRoutesCalled_thenNoAuthGuard', async () => {
    const server = app.getHttpServer();
    const login = await request(server).post('/auth/login').send({});
    const refresh = await request(server).post('/auth/refresh').send({});
    expect(login.status, 'login público não deve cair no AuthGuard').toBe(400);
    expect(refresh.status, 'refresh público não deve cair no AuthGuard').toBe(400);
    expect((await request(server).post('/auth/sign-in').send({})).status).toBe(404);
    expect((await request(server).post('/cadastro').send({})).status).toBe(404);
    expect((await request(server).post('/auth/logout').send({})).status).toBe(404);
    expect((await request(server).get('/auth/check')).status, 'check permanece guardado').toBe(401);
  });

  it('whenNoTrustedProxyConfigured_thenThrottleKeyIsSocketAddress', () => {
    const main = readFileSync(path.resolve(process.cwd(), 'apps/cliente/src/main.ts'), 'utf8');
    const controller = readFileSync(
      path.resolve(process.cwd(), 'apps/cliente/src/auth/public-auth.controller.ts'),
      'utf8',
    );
    // Tokens montados em partes: o próprio teste não pode conter o literal proibido.
    const forbidden = [['trust', 'proxy'].join(' '), ['TRUSTED', '_PROXY_HOPS'].join('')];
    for (const token of forbidden) {
      expect(main.toLowerCase()).not.toContain(token.toLowerCase());
      expect(controller.toLowerCase()).not.toContain(token.toLowerCase());
    }
    expect(controller).toContain('request.ip');
    expect(controller.toLowerCase()).not.toContain(['x-forwarded', '-for'].join(''));
    const instance = app.getHttpAdapter().getInstance() as { get(key: string): unknown };
    expect(instance.get(forbidden[0])).toBeFalsy();
  });

  it('whenTwoDistinctSocketIps_thenThrottleBucketsAreIndependent', async () => {
    // Sem proxy, o valor que o controller passa ao throttle é o socket address.
    const throttle = app.get<LoginThrottle>(LOGIN_THROTTLE);
    const ipA = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const ipB = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(withLoginThrottle(throttle, ipA, async () => 'ok')).resolves.toBe('ok');
    }
    const blocked = await withLoginThrottle(throttle, ipA, async () => 'ok').catch(
      (error: unknown) => error,
    );
    expect(blocked).toBeInstanceOf(ThrottledException);
    expect((blocked as ThrottledException).retryAfterSeconds).toBeGreaterThan(0);
    await expect(withLoginThrottle(throttle, ipB, async () => 'ok')).resolves.toBe('ok');
  });

  it('whenCheckCalled_thenGoldenBody', async () => {
    const fixture = JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
      casos: Record<string, { snapshot: { body: Record<string, unknown> } }>;
    };
    const token = signToken(env, { sub: 'auth05-admin', role: 'admin' });
    const response = await request(app.getHttpServer())
      .get('/auth/check')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual(fixture.casos.admin.snapshot.body);
    expect(Object.keys(response.body).sort()).toEqual(['authorized', 'context', 'role']);
  });

  it('whenEmailResolverInspected_thenNarrowSecurityDefiner', async () => {
    const result = await pool.query(
      [
        'SELECT prosecdef, proconfig::text AS proconfig, proacl::text AS proacl, prorettype::regtype::text AS retorno',
        " FROM pg_proc WHERE oid = 'cliente.sub_por_email(text)'::regprocedure",
      ].join(' '),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].prosecdef).toBe(true);
    expect(result.rows[0].retorno).toBe('text');
    expect(String(result.rows[0].proconfig)).toContain('search_path=cliente, pg_temp');
    const acl = String(result.rows[0].proacl);
    expect(acl).toContain('cliente_app_role=X');
    expect(acl).not.toMatch(/(^|\{|,)=X/); // sem EXECUTE para PUBLIC; owner não é PUBLIC.

    const hashFn = await pool.query(
      [
        'SELECT prosrc FROM pg_proc',
        " WHERE oid = 'cliente.sub_por_hash_refresh(text)'::regprocedure",
      ].join(' '),
    );
    expect(hashFn.rows[0].prosrc).toContain('refresh_tokens');
    expect(hashFn.rows[0].prosrc).not.toContain('credenciais');
  });

  it('whenExtraFieldInLogin_then400NamingField', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'cliente@example.test', password: 'senha-com-12', injectedField: 'x' })
      .expect(400);
    expect(response.body.field).toBe('injectedField');
    expect(JSON.stringify(response.body)).not.toContain(['contexto', 'inválido'].join(' '));
  });

  it('whenPasswordShorterThan12_then400NamingPassword', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'cliente@example.test', password: 'curta' })
      .expect(400);
    expect(response.body.field).toBe('password');
  });

  it('whenSixthRequestPerIpWithin60s_then429WithRetryAfter', async () => {
    const sub = `${PREFIX}-throttle`;
    await seed(sub, 'senha-com-12');
    const isolated = await createIsolatedApp();
    try {
      const server = isolated.getHttpServer();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(server)
          .post('/auth/login')
          .send({ email: `${sub}@example.test`, password: 'senha-errada-12' })
          .expect(401);
      }
      const sixth = await request(server)
        .post('/auth/login')
        .send({ email: `${sub}@example.test`, password: 'senha-errada-12' })
        .expect(429);
      expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await isolated.close();
    }
  });

  it('whenThirdConcurrentHash_then429WithRetryAfter', async () => {
    const sub = `${PREFIX}-concorrente`;
    await seed(sub, 'senha-com-12');
    const isolated = await createIsolatedApp();
    try {
      const server = isolated.getHttpServer();
      const attempts = await Promise.all(
        [0, 1, 2].map(() =>
          request(server)
            .post('/auth/login')
            .send({ email: `${sub}@example.test`, password: 'senha-errada-12' }),
        ),
      );
      const statuses = attempts.map((item) => item.status).sort();
      expect(statuses).toEqual([401, 401, 429]);
      for (const item of attempts.filter((candidate) => candidate.status === 429)) {
        expect(Number(item.headers['retry-after'])).toBeGreaterThan(0);
      }
    } finally {
      await isolated.close();
    }
  });

  it('whenLoginSucceeds_thenTokensAreV1Envelope', async () => {
    const sub = `${PREFIX}-sucesso`;
    await seed(sub, 'senha-com-12');
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: `${sub}@example.test`, password: 'senha-com-12' })
      .expect(200);
    expect(response.body.version).toBe('v1');
    expect(Object.keys(response.body.data).sort()).toEqual([
      'accessToken', 'expiresIn', 'refreshToken',
    ]);
    expect(response.body.data.expiresIn).toBe(900);
    expect(response.body.data.refreshToken.split('.')).toHaveLength(1);
  });

  it('whenUsedRefreshReused_then401StableAndFamilyRevoked', async () => {
    const sub = `${PREFIX}-reuso`;
    const opaque = randomUUID();
    const family = await seedRefresh(sub, opaque);
    const server = app.getHttpServer();

    const first = await request(server).post('/auth/refresh').send({ refreshToken: opaque }).expect(200);
    expect(first.body.version).toBe('v1');
    expect(first.body.data.refreshToken).not.toBe(opaque);

    const reused = await request(server)
      .post('/auth/refresh')
      .send({ refreshToken: opaque })
      .expect(401);
    expect(reused.body).toEqual({ message: 'Unauthorized', statusCode: 401 });
    expect(JSON.stringify(reused.body)).not.toContain(opaque);

    const tokens = await pool.query('SELECT estado FROM cliente.refresh_tokens WHERE family_id = $1', [family]);
    expect(tokens.rows.length).toBeGreaterThanOrEqual(2);
    expect(tokens.rows.every((row) => row.estado === 'revogado')).toBe(true);
  });
});
