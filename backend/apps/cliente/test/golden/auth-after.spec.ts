import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { LOGIN_THROTTLE, createLoginThrottle } from '../../src/auth/login-throttle';
import { hashPassword } from '../../src/auth/password-hasher';
import { SecurityLogger } from '../../src/auth/security-logger';
import { SESSION_STORE, createInMemorySessionStore } from '../../src/auth/session-store';
import { CLIENTE_DB, type NamedDatabase } from '../../src/database/database.tokens';
import {
  configureEnv,
  createTestApp,
  signToken,
  unsignedToken,
  type TestEnv,
} from '../support/setup';

// AUTH-11: golden "depois". Nunca reescreve o golden "antes" assinado; compara
// o estado atual caso a caso contra auth-before.fixture.json e contra o expected
// aprovado das rotas novas. Nenhum valor sensível é gravado: sentinéis apenas.
const FIXTURE_PATH = path.resolve(
  process.cwd(),
  'apps/cliente/test/golden/auth-before.fixture.json',
);
const APPROVERS = ['product-manager', 'qa-engineer'] as const;
type Approver = (typeof APPROVERS)[number];
const CASE_IDS = [
  'sem token',
  'cross-app',
  'expirado',
  'unsigned',
  'viewer',
  'admin',
  'campo extra',
] as const;
const EXPECTED_ROUTES = ['POST /auth/login', 'POST /auth/refresh'] as const;
type CaseId = (typeof CASE_IDS)[number];
type ExpectedRoute = (typeof EXPECTED_ROUTES)[number];
const TOKEN_SENTINEL = '<PLACEHOLDER_TOKEN>';
const CORRELATION_SENTINEL = '<PLACEHOLDER_CORRELATION_ID>';

interface Snapshot {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}
interface GoldenCase {
  request: { method: string; path: string; token?: string | null; body?: Record<string, unknown> };
  snapshot: Snapshot;
}
interface ExpectedCase {
  proposto: Snapshot;
  aprovado_por: string;
  data: string;
  origem: string;
}
interface Fixture {
  aprovacaoGolden: { aprovado_por: string; data: string; artefato?: string };
  normalizacao: { excluidos: Record<string, string>; preservados: string[] };
  casos: Record<string, GoldenCase>;
  expected: Record<string, ExpectedCase>;
}
interface Divergence {
  caseId: string;
  field: string;
  before: unknown;
  after: unknown;
}

function readFixture(): Fixture | null {
  try {
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
  } catch {
    return null;
  }
}
const fixture = readFixture();

/** Guarda de aprovação humana idêntica à da AUTH-01: allow-list fechada. */
function isApprovedByHumans(source: Fixture | null, routes: readonly string[]): boolean {
  if (!source) return false;
  const artifact = source.aprovacaoGolden;
  if (!artifact || typeof artifact.artefato !== 'string' || artifact.artefato.trim() === '') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(artifact.data ?? '')) return false;
  const aprovacoes = routes.map((route) => source.expected?.[route]?.aprovado_por);
  if (aprovacoes.some((value) => !APPROVERS.includes(value as Approver))) return false;
  return new Set(aprovacoes).size === routes.length;
}

// date é HTTP-date volátil: exclusão declarada no golden "antes"; nenhum header
// de segurança é removido. Todo o resto (inclusive x-*) é preservado.
function normalize(response: {
  status: number;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}): Snapshot {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === 'date' || value === undefined) continue;
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return { status: response.status, body: response.body, headers };
}

/** Comparação caso a caso: status, body profundo e cada header. Nada é omitido. */
function compareSnapshots(caseId: string, before: Snapshot, after: Snapshot): Divergence[] {
  const found: Divergence[] = [];
  if (before.status !== after.status) {
    found.push({ caseId, field: 'status', before: before.status, after: after.status });
  }
  if (!isDeepStrictEqual(before.body, after.body)) {
    found.push({ caseId, field: 'body', before: before.body, after: after.body });
  }
  const keys = [...new Set([...Object.keys(before.headers), ...Object.keys(after.headers)])].sort();
  for (const key of keys) {
    if (before.headers[key] !== after.headers[key]) {
      found.push({
        caseId,
        field: `headers.${key}`,
        before: before.headers[key],
        after: after.headers[key],
      });
    }
  }
  return found;
}

describe('golden "depois" — AUTH-11 (comparação antes/depois caso a caso)', () => {
  let app: INestApplication;
  let env: TestEnv;

  beforeAll(async () => {
    env = configureEnv();
    const db = {
      token: CLIENTE_DB,
      schema: 'cliente',
      role: 'cliente_app_role',
      probe: vi.fn(async () => true),
    } as unknown as NamedDatabase;
    app = await createTestApp(AppModule, CLIENTE_DB, db, [
      { token: SESSION_STORE, value: createInMemorySessionStore() },
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  function authorizationFor(token: string | null | undefined): string | undefined {
    switch (token) {
      case null:
      case undefined:
        return undefined;
      case 'cross-app':
        return `Bearer ${signToken(env, { sub: 'golden-op', role: 'admin' }, {
          issuer: 'https://issuer.test/control-plane',
          audience: 'atlas-control-plane',
        })}`;
      case 'expirado':
        return `Bearer ${signToken(env, { sub: 'golden-u', role: 'admin' }, { expiresIn: '-1s' })}`;
      case 'unsigned':
        return `Bearer ${unsignedToken({ sub: 'golden-u', role: 'admin' })}`;
      case 'viewer':
        return `Bearer ${signToken(env, { sub: 'golden-viewer', role: 'viewer' })}`;
      case 'admin':
        return `Bearer ${signToken(env, { sub: 'golden-admin', role: 'admin' })}`;
      default:
        throw new Error(`tokenKind desconhecido no fixture: ${token}`);
    }
  }

  async function capture(id: CaseId): Promise<Snapshot> {
    const definition = (fixture as Fixture).casos[id];
    const base = request(app.getHttpServer());
    let call = definition.request.method === 'POST'
      ? base.post(definition.request.path).send(definition.request.body)
      : base.get(definition.request.path);
    const authorization = authorizationFor(definition.request.token);
    if (authorization) call = call.set('Authorization', authorization);
    return normalize(await call);
  }

  it('whenGoldenAfterCompared_thenBeforeAndAfterMatchCaseByCase', async () => {
    expect(fixture, 'golden "antes" assinado ausente').not.toBeNull();
    const golden = fixture as Fixture;
    expect(Object.keys(golden.casos).sort(), 'casos congelados').toEqual([...CASE_IDS].sort());

    const divergences: Divergence[] = [];
    for (const id of CASE_IDS) {
      const before = golden.casos[id].snapshot;
      expect(before, `${id}: snapshot "antes" ausente`).toBeDefined();
      const after = await capture(id);
      expect(typeof after.status, `${id}: status "depois"`).toBe('number');
      expect(after.body, `${id}: body "depois"`).toBeDefined();
      expect(Object.keys(after.headers).length, `${id}: headers "depois"`).toBeGreaterThan(0);
      divergences.push(...compareSnapshots(id, before, after));
    }

    expect(
      divergences,
      `divergências antes/depois: ${divergences.map((d) => `${d.caseId}.${d.field}`).join(', ')}`,
    ).toEqual([]);

    expect(golden.normalizacao.excluidos.date, 'justificativa de date').toContain('volátil');
    const adminLive = await capture('admin');
    expect(adminLive.headers.date, 'date não entra no golden').toBeUndefined();
    for (const header of Object.keys(golden.casos.admin.snapshot.headers).filter((h) => h.startsWith('x-'))) {
      expect(adminLive.headers[header], `header ${header} preservado`).toBe(
        golden.casos.admin.snapshot.headers[header],
      );
    }
  });

  it('whenCaseDiverges_thenReportsField', () => {
    const golden = (fixture as Fixture).casos.admin.snapshot;
    const mutated: Snapshot = { ...golden, status: 500 };
    const found = compareSnapshots('admin', golden, mutated);
    expect(found.length, 'divergência deve ser detectada').toBeGreaterThan(0);
    expect(found.some((item) => item.caseId === 'admin' && item.field === 'status')).toBe(true);
  });

  it('whenExpectedMissing_thenFailsClosed', () => {
    const source = structuredClone(fixture as Fixture);
    delete source.expected['POST /auth/login'];
    expect(isApprovedByHumans(source, EXPECTED_ROUTES), 'expected ausente não aprova por vazio').toBe(false);
  });
});

describe('golden "depois" — rotas novas contra expected aprovado (AUTH-11)', () => {
  const SUB = 'golden-after-sub';
  const PASSWORD = `senha-${'com12caracteres'}`;

  /** Pool em memória: nenhuma porta, nenhuma URL, nenhum segredo real. */
  function fakeNamedDatabase(hash: string): NamedDatabase {
    const client = {
      query: async (sql: string) => {
        if (/INSERT INTO cliente\.refresh_tokens/.test(sql)) return { rows: [], rowCount: 1 };
        if (sql.includes('sub_por_hash_refresh')) return { rows: [{ sub: SUB }], rowCount: 1 };
        if (/SELECT family_id, jti, estado, expira_em/.test(sql)) {
          return {
            rows: [{
              family_id: 'golden-family',
              jti: 'golden-jti',
              estado: 'ativo',
              expira_em: new Date(Date.now() + 3_600_000).toISOString(),
            }],
            rowCount: 1,
          };
        }
        if (/UPDATE cliente\.refresh_tokens/.test(sql)) {
          return { rows: [{ family_id: 'golden-family' }], rowCount: 1 };
        }
        if (/SELECT c\.role/.test(sql)) return { rows: [{ role: 'admin', mfa: false }], rowCount: 1 };
        if (sql.includes('password_hash')) {
          return { rows: [{ password_hash: hash, role: 'admin', mfa: false }], rowCount: 1 };
        }
        if (sql.includes('sub_por_email')) return { rows: [{ sub: SUB }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    return {
      token: CLIENTE_DB,
      schema: 'cliente',
      role: 'cliente_app_role',
      probe: vi.fn(async () => true),
      pool: { connect: async () => client } as unknown as Pool,
    } as unknown as NamedDatabase;
  }

  async function captureNewRoute(route: ExpectedRoute): Promise<Snapshot> {
    configureEnv();
    const hash = await hashPassword(PASSWORD);
    const app = await createTestApp(AppModule, CLIENTE_DB, fakeNamedDatabase(hash), [
      { token: SESSION_STORE, value: createInMemorySessionStore() },
      { token: LOGIN_THROTTLE, value: createLoginThrottle() },
      { token: SecurityLogger as unknown as string, value: { emit: vi.fn() } },
    ]);
    try {
      const body = route === 'POST /auth/login'
        ? { email: `${SUB}@example.test`, password: PASSWORD }
        : { refreshToken: 'opaco-de-teste' };
      const response = await request(app.getHttpServer()).post(route.slice(5)).send(body);
      return normalize(response);
    } finally {
      await app.close();
    }
  }

  /** Tokens e correlation-id reais são provados presentes e trocados por sentinéis. */
  function redactEnvelope(live: Snapshot): Snapshot {
    const data = (live.body as { data?: { accessToken?: unknown; refreshToken?: unknown } })?.data;
    expect(typeof data?.accessToken, 'accessToken real presente').toBe('string');
    expect((data?.accessToken as string).split('.')).toHaveLength(3);
    expect(typeof data?.refreshToken, 'refreshToken real presente').toBe('string');
    expect((data?.refreshToken as string).length).toBeGreaterThan(20);
    const correlation = live.headers['x-correlation-id'];
    expect(correlation, 'x-correlation-id real presente').toBeTruthy();
    expect(correlation).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/);
    return {
      status: live.status,
      body: {
        ...(live.body as Record<string, unknown>),
        data: { ...data, accessToken: TOKEN_SENTINEL, refreshToken: TOKEN_SENTINEL },
      },
      headers: {
        'content-type': live.headers['content-type'],
        'x-correlation-id': CORRELATION_SENTINEL,
      },
    };
  }

  it('whenNewRoutesCompared_thenMatchApprovedExpected', async () => {
    expect(isApprovedByHumans(fixture, EXPECTED_ROUTES), 'aprovação humana das rotas novas').toBe(true);
    for (const route of EXPECTED_ROUTES) {
      const expected = (fixture as Fixture).expected[route].proposto;
      const live = redactEnvelope(await captureNewRoute(route));
      const divergences = compareSnapshots(route, expected, live);
      expect(divergences, `${route}: divergências vs expected aprovado`).toEqual([]);
    }
  });

  it('whenNewRouteExpectedForged_thenGuardStaysLocked', () => {
    const source = structuredClone(fixture as Fixture);
    source.expected['POST /auth/login'].aprovado_por = 'backend-engineer';
    expect(isApprovedByHumans(source, EXPECTED_ROUTES), 'aprovador forjado não destrava').toBe(false);
  });
});
