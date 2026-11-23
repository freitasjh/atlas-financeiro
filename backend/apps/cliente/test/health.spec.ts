import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { CLIENTE_DB } from '../src/database/database.tokens';
import { configureEnv, createTestApp } from './support/setup';

describe('GET /health no app cliente', () => {
  let app: INestApplication;
  const probe = vi.fn(async () => true);

  beforeAll(async () => {
    configureEnv();
    app = await createTestApp(
      AppModule,
      CLIENTE_DB,
      { token: CLIENTE_DB, schema: 'cliente', role: 'cliente_app_role', probe },
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('whenDatabaseUp_thenReturns200WithFrozenPayloadAndContextCliente', async () => {
    probe.mockResolvedValueOnce(true);
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok', db: 'up', context: 'cliente' });
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
