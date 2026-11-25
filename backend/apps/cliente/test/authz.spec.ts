import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { DatabaseSessionStore } from '../src/auth/database-session-store';
import { withClienteAppRole } from '../src/auth/cliente-app-role';
import { SESSION_STORE, createInMemorySessionStore } from '../src/auth/session-store';
import { CLIENTE_DB, type NamedDatabase } from '../src/database/database.tokens';
import { configureEnv, createTestApp, signToken, unsignedToken, type TestEnv } from './support/setup';
import { loadB2Env } from './support/b2-gate';
import { applyClienteMigration } from './support/migrate';

describe('autorização no app cliente', () => {
  let app: INestApplication;
  let env: TestEnv;

  beforeAll(async () => {
    env = configureEnv();
    app = await createTestApp(
      AppModule,
      CLIENTE_DB,
      {
        token: CLIENTE_DB,
        schema: 'cliente',
        role: 'cliente_app_role',
        probe: vi.fn(async () => true),
      },
      [{ token: SESSION_STORE, value: createInMemorySessionStore() }],
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('whenNoToken_thenReturns401', async () => {
    await request(app.getHttpServer()).get('/auth/check').expect(401);
  });

  it('whenTokenFromControlPlaneContext_thenReturns401', async () => {
    const token = signToken(env, { sub: 'op-1', role: 'admin' }, {
      issuer: 'https://issuer.test/control-plane',
      audience: 'atlas-control-plane',
    });
    await request(app.getHttpServer())
      .get('/auth/check')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('whenExpiredToken_thenReturns401', async () => {
    const token = signToken(env, { sub: 'u-1', role: 'admin' }, { expiresIn: '-1s' });
    await request(app.getHttpServer())
      .get('/auth/check')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('whenUnsignedToken_thenReturns401', async () => {
    await request(app.getHttpServer())
      .get('/auth/check')
      .set('Authorization', `Bearer ${unsignedToken({ sub: 'u-1', role: 'admin' })}`)
      .expect(401);
  });

  it('whenRoleNotAllowed_thenReturns403', async () => {
    const token = signToken(env, { sub: 'u-2', role: 'viewer' });
    await request(app.getHttpServer())
      .get('/auth/check')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('whenRoleAllowed_thenReturns200WithoutPii', async () => {
    const token = signToken(env, { sub: 'u-1', role: 'admin' });
    const response = await request(app.getHttpServer())
      .get('/auth/check')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual({ authorized: true, context: 'cliente', role: 'admin' });
  });

  it('whenExtraFieldInValidatedBody_thenReturns400NamingTheField', async () => {
    const response = await request(app.getHttpServer())
      .post('/contracts/validate')
      .send({
        version: 'v1',
        data: { status: 'ok', db: 'up', context: 'cliente' },
        injectedField: 'x',
      })
      .expect(400);
    expect(JSON.stringify(response.body)).toContain('injectedField');
    expect(JSON.stringify(response.body)).not.toContain(['contexto', 'inválido'].join(' '));
  });

  it('whenJtiRevokedInDb_thenGuardAwaitsAndDenies', async () => {
    const b2 = loadB2Env();
    expect(b2.CLIENTE_DATABASE_URL, 'CLIENTE_DATABASE_URL ausente (B2)').toBeTruthy();
    const dbPool = new Pool({ connectionString: b2.CLIENTE_DATABASE_URL });
    try {
      await applyClienteMigration(dbPool);
      const sub = `authz-${randomUUID().slice(0, 8)}`;
      const jti = `jti-${sub}`;
      const currentUser = await withClienteAppRole(dbPool, sub, async (client) => {
        const row = await client.query('SELECT current_user');
        await client.query(
          'INSERT INTO cliente.revogacoes (jti, sub, motivo) VALUES ($1, $2, $3)',
          [jti, sub, 'teste-authz'],
        );
        return row.rows[0].current_user;
      });
      expect(currentUser).toBe('cliente_app_role');

      const named = {
        token: CLIENTE_DB,
        schema: 'cliente',
        role: 'cliente_app_role',
        url: '',
        pool: dbPool,
        probe: vi.fn(async () => true),
      } as unknown as NamedDatabase;
      const store = new DatabaseSessionStore(named);
      const dbApp = await createTestApp(AppModule, CLIENTE_DB, named, [
        { token: SESSION_STORE, value: store },
      ]);
      try {
        const token = signToken(env, { sub, role: 'admin', jti });
        const response = await request(dbApp.getHttpServer())
          .get('/auth/check')
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
        expect(response.body).not.toEqual({ authorized: true, context: 'cliente', role: 'admin' });
        expect(await store.isRevoked(sub, jti)).toBe(true);
        expect(await store.isRevoked(`outro-${sub}`, jti)).toBe(false);
      } finally {
        await dbApp.close();
      }
    } finally {
      await dbPool.query('DELETE FROM cliente.revogacoes WHERE sub LIKE $1', ['authz-%']);
      await dbPool.end();
    }
  });

  it('whenProductionWithInMemoryStore_thenBootRefuses', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => createInMemorySessionStore()).toThrow(/proibido em produção/);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
