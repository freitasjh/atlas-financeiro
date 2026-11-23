import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { CLIENTE_DB } from '../src/database/database.tokens';
import { configureEnv, createTestApp, signToken, unsignedToken, type TestEnv } from './support/setup';

describe('autorização no app cliente', () => {
  let app: INestApplication;
  let env: TestEnv;

  beforeAll(async () => {
    env = configureEnv();
    app = await createTestApp(AppModule, CLIENTE_DB, {
      token: CLIENTE_DB,
      schema: 'cliente',
      role: 'cliente_app_role',
      probe: vi.fn(async () => true),
    });
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
});
