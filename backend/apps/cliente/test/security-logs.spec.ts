import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Logger, type INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { withClienteAppRole } from '../src/auth/cliente-app-role';
import { LOGIN_THROTTLE, createLoginThrottle } from '../src/auth/login-throttle';
import { hashPassword } from '../src/auth/password-hasher';
import { hashRefreshToken } from '../src/auth/refresh-service';
import {
  SecurityLogger,
  resolveCorrelationId,
  type SecurityEvent,
} from '../src/auth/security-logger';
import { SESSION_STORE, createInMemorySessionStore } from '../src/auth/session-store';
import { CLIENTE_DB, type NamedDatabase } from '../src/database/database.tokens';
import { loadB2Env } from './support/b2-gate';
import { applyClienteMigration } from './support/migrate';
import { configureEnv, createTestApp, signToken, type TestEnv } from './support/setup';

/**
 * NFR-05 / AUTH-14 — trilha de segurança correlacionada.
 * Nenhum arquivo é gravado: eventos ficam em memória no spy do provider.
 * Nenhum valor sensível é impresso; somente comparado com o payload auditado.
 */
type SecurityCall = readonly [SecurityEvent, string, string];
const PREFIX = `sec-${randomUUID().slice(0, 8)}`;
const emitted: SecurityCall[] = [];
const sensitiveValues: string[] = [];
const sink = {
  emit: vi.fn((event: SecurityEvent, reason: string, correlationId: string) => {
    emitted.push([event, reason, correlationId]);
  }),
} as unknown as SecurityLogger;

const env = loadB2Env();
const apps: INestApplication[] = [];
let testEnv: TestEnv;
let pool: Pool;
let named: NamedDatabase;

const callsFrom = (index: number): SecurityCall[] => emitted.slice(index);
const eventsOf = (calls: SecurityCall[]): SecurityEvent[] => calls.map((call) => call[0]);

async function createApp(
  sessions = createInMemorySessionStore(),
): Promise<INestApplication> {
  const app = await createTestApp(AppModule, CLIENTE_DB, named, [
    { token: SESSION_STORE, value: sessions },
    { token: LOGIN_THROTTLE, value: createLoginThrottle() },
    { token: SecurityLogger as unknown as string, value: sink },
  ]);
  apps.push(app);
  return app;
}

async function seedCredential(sub: string, clearValue: string): Promise<string> {
  const email = `${sub}@example.test`;
  const stored = await hashPassword(clearValue);
  await withClienteAppRole(pool, sub, async (client) => {
    await client.query(
      'INSERT INTO cliente.credenciais (sub, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      [sub, email, stored, 'admin'],
    );
  });
  return email;
}

async function seedRefresh(sub: string, opaque: string): Promise<void> {
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
      [sub, hashRefreshToken(opaque), `${PREFIX}-family-${sub}`, `jti-${sub}`],
    );
  });
}

beforeAll(async () => {
  expect(env.CLIENTE_DATABASE_URL, 'CLIENTE_DATABASE_URL ausente (B2)').toBeTruthy();
  testEnv = configureEnv();
  pool = new Pool({ connectionString: env.CLIENTE_DATABASE_URL });
  await applyClienteMigration(pool);
  named = {
    token: CLIENTE_DB,
    schema: 'cliente',
    role: 'cliente_app_role',
    url: '',
    pool,
    probe: vi.fn(async () => true),
  } as unknown as NamedDatabase;
});

afterAll(async () => {
  for (const app of apps) await app.close();
  if (pool) {
    await pool.query('DELETE FROM cliente.revogacoes WHERE sub LIKE $1', [`${PREFIX}%`]);
    await pool.query('DELETE FROM cliente.refresh_tokens WHERE sub LIKE $1', [`${PREFIX}%`]);
    await pool.query('DELETE FROM cliente.credenciais WHERE sub LIKE $1', [`${PREFIX}%`]);
    await pool.end();
  }
});

describe('NFR-05 — trilha de segurança correlacionada (AUTH-14)', () => {
  it('whenLoginSucceeds_thenSecurityEventHasCorrelationId', async () => {
    const sub = `${PREFIX}-ok`;
    const clearValue = 'senha-com-12';
    const email = await seedCredential(sub, clearValue);
    sensitiveValues.push(email, clearValue);

    const correlationId = randomUUID();
    const app = await createApp();
    const start = emitted.length;
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set('x-correlation-id', correlationId)
      .send({ email, password: clearValue })
      .expect(200);

    expect(response.headers['x-correlation-id']).toBe(correlationId);
    const calls = callsFrom(start);
    expect(eventsOf(calls)).toEqual(['login-success']);
    expect(calls[0][1]).toBe('authenticated');
    expect(calls[0][2]).toBe(correlationId);
    sensitiveValues.push(response.body.data.accessToken, response.body.data.refreshToken);
  });

  it('whenLoginFails_thenNoSecretInPayload', async () => {
    const sub = `${PREFIX}-falha`;
    const clearValue = 'senha-com-12';
    const wrongValue = 'senha-errada-12';
    const email = await seedCredential(sub, clearValue);
    sensitiveValues.push(email, clearValue, wrongValue);

    const correlationId = randomUUID();
    const app = await createApp();
    const server = app.getHttpServer();

    const startInvalid = emitted.length;
    await request(server)
      .post('/auth/login')
      .set('x-correlation-id', correlationId)
      .send({ email, password: wrongValue })
      .expect(401);
    const invalid = callsFrom(startInvalid);
    expect(eventsOf(invalid)).toEqual(['login-failure']);
    expect(invalid[0][1]).toBe('invalid-credentials');
    expect(invalid[0][2]).toBe(correlationId);

    const shortValue = 'curta';
    sensitiveValues.push(shortValue);
    const startInput = emitted.length;
    await request(server)
      .post('/auth/login')
      .set('x-correlation-id', correlationId)
      .send({ email, password: shortValue })
      .expect(400);
    const input = callsFrom(startInput);
    expect(eventsOf(input)).toEqual(['login-failure']);
    expect(input[0][1]).toBe('invalid-input');
    expect(input[0][2]).toBe(correlationId);

    // App nova: o throttle do caso acima já consumiu tentativas deste IP.
    const rateServer = (await createApp()).getHttpServer();
    const startRate = emitted.length;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(rateServer).post('/auth/login').send({ email, password: wrongValue }).expect(401);
    }
    await request(rateServer).post('/auth/login').send({ email, password: wrongValue }).expect(429);
    const rate = callsFrom(startRate);
    expect(eventsOf(rate)).toEqual(Array(6).fill('login-failure'));
    expect(rate.map((call) => call[1])).toContain('rate-limited');

    const serialized = JSON.stringify(callsFrom(startInvalid));
    for (const value of sensitiveValues) expect(serialized).not.toContain(value);
  });

  it('whenUnauthorizedOrForbidden_thenEventsEmitted', async () => {
    const app = await createApp();
    const server = app.getHttpServer();
    const anonymousId = randomUUID();
    const startAnon = emitted.length;
    await request(server).get('/auth/check').set('x-correlation-id', anonymousId).expect(401);
    const anon = callsFrom(startAnon);
    expect(eventsOf(anon)).toContain('401');
    expect(anon.every((call) => call[2] === anonymousId)).toBe(true);

    const viewerId = randomUUID();
    const viewer = signToken(testEnv, {
      sub: `${PREFIX}-viewer`,
      role: 'viewer',
      jti: randomUUID(),
    });
    const startViewer = emitted.length;
    await request(server)
      .get('/auth/check')
      .set('Authorization', `Bearer ${viewer}`)
      .set('x-correlation-id', viewerId)
      .expect(403);
    const denied = callsFrom(startViewer);
    expect(eventsOf(denied)).toContain('403');
    expect(denied.every((call) => call[2] === viewerId)).toBe(true);
    sensitiveValues.push(viewer);

    const sessions = createInMemorySessionStore();
    const revokedApp = await createApp(sessions);
    const revokedId = randomUUID();
    const jti = randomUUID();
    const admin = signToken(testEnv, {
      sub: `${PREFIX}-revogado`,
      role: 'admin',
      jti,
    });
    await sessions.revoke(`${PREFIX}-revogado`, jti);
    const startRevoked = emitted.length;
    await request(revokedApp.getHttpServer())
      .get('/auth/check')
      .set('Authorization', `Bearer ${admin}`)
      .set('x-correlation-id', revokedId)
      .expect(403);
    const revoked = callsFrom(startRevoked);
    expect(eventsOf(revoked)).toContain('403');
    expect(revoked.every((call) => call[2] === revokedId)).toBe(true);
    sensitiveValues.push(admin);
  });

  it('whenRefreshReused_thenReuseAndFamilyRevokedLogged', async () => {
    const sub = `${PREFIX}-reuso`;
    const opaque = randomUUID();
    const correlationId = randomUUID();
    await seedRefresh(sub, opaque);
    sensitiveValues.push(opaque);

    const app = await createApp();
    const server = app.getHttpServer();
    const start = emitted.length;
    const first = await request(server)
      .post('/auth/refresh')
      .set('x-correlation-id', correlationId)
      .send({ refreshToken: opaque })
      .expect(200);
    sensitiveValues.push(first.body.data.refreshToken);
    expect(first.headers['x-correlation-id']).toBe(correlationId);

    await request(server)
      .post('/auth/refresh')
      .set('x-correlation-id', correlationId)
      .send({ refreshToken: opaque })
      .expect(401);

    const calls = callsFrom(start);
    expect(eventsOf(calls)).toEqual(
      expect.arrayContaining(['refresh-reuse', 'family-revoked']),
    );
    expect(calls.find((call) => call[0] === 'refresh-reuse')?.[1]).toBe('refresh-reused');
    expect(calls.find((call) => call[0] === 'family-revoked')?.[1]).toBe('family-revoked');
    expect(calls.every((call) => call[2] === correlationId)).toBe(true);
  });

  it('whenLogPayloadAudited_thenNoTokenPasswordPii', async () => {
    const sixEvents: SecurityEvent[] = [
      'login-success', 'login-failure', '401', '403', 'refresh-reuse', 'family-revoked',
    ];
    expect([...new Set(eventsOf(emitted))].sort()).toEqual([...sixEvents].sort());
    expect(emitted.length).toBeGreaterThanOrEqual(sixEvents.length);
    for (const call of emitted) {
      expect(call).toHaveLength(3);
      expect(call[2]).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/);
    }
    for (const value of sensitiveValues) expect(JSON.stringify(emitted)).not.toContain(value);

    const supplied = `${PREFIX}@example.test`;
    expect(resolveCorrelationId({ 'x-correlation-id': supplied })).not.toContain('@');

    const spy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      new SecurityLogger().emit('login-success', 'authenticated', randomUUID());
      const payload = JSON.parse(String(spy.mock.calls[0][0])) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        'context', 'correlationId', 'event', 'reason',
      ]);
      expect(payload.context).toBe('cliente');
      expect(JSON.stringify(payload)).not.toContain('@');
    } finally {
      spy.mockRestore();
    }
  });
});
