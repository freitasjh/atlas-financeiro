import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { CONTROL_PLANE_DB } from '../src/database/database.tokens';
import { configureEnv, createTestApp } from './support/setup';

describe('GET /health no app control-plane', () => {
  let app: INestApplication;
  const probe = vi.fn(async () => true);

  beforeAll(async () => {
    configureEnv();
    app = await createTestApp(
      AppModule,
      CONTROL_PLANE_DB,
      { token: CONTROL_PLANE_DB, schema: 'control_plane', role: 'control_plane_app_role', probe },
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('whenDatabaseUp_thenReturns200WithFrozenPayloadAndContextCliente', async () => {
    probe.mockResolvedValueOnce(true);
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok', db: 'up', context: 'control-plane' });
  });

  it('whenDatabaseDown_thenReturns503WithDegradedPayloadOnly', async () => {
    probe.mockResolvedValueOnce(false);
    const response = await request(app.getHttpServer()).get('/health').expect(503);
    expect(response.body).toEqual({ status: 'degraded', db: 'down' });
  });

  it('whenPayloadRead_thenContainsNoSecretTokenOrPii', async () => {
    probe.mockResolvedValueOnce(true);
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/secret|token|email|password/i);
    expect(Object.keys(response.body).sort()).toEqual(['context', 'db', 'status']);
  });
});
