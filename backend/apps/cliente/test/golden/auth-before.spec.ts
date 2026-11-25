import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { SESSION_STORE, createInMemorySessionStore } from '../../src/auth/session-store';
import { CLIENTE_DB } from '../../src/database/database.tokens';
import {
  configureEnv,
  createTestApp,
  signToken,
  unsignedToken,
  type TestEnv,
} from '../support/setup';

// AUTH-01: golden "antes". Nenhuma rota é editada aqui; chave EC efêmera vem de support/setup.
const FIXTURE_PATH = path.resolve(
  process.cwd(),
  'apps/cliente/test/golden/auth-before.fixture.json',
);
const PENDING_APPROVAL = 'pendente de aprovacao humana';
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
  proposto: { status: number; body: unknown; headers: Record<string, string> };
  aprovado_por: string;
  data: string;
  origem: string;
}
interface Fixture {
  fixtureVersion: string;
  capturadoEm: string;
  capturadoPor: string;
  aprovacaoGolden: { aprovado_por: string; data: string; artefato?: string };
  escopo: string;
  normalizacao: { excluidos: Record<string, string>; preservados: string[] };
  casos: Record<string, GoldenCase>;
  expected: Record<string, ExpectedCase>;
}

// Guarda de aprovação: allow-list fechada, AMBOS os aprovadores no conjunto e
// artefato de assinatura datado. Qualquer outra string — inclusive "eu" — fica suspensa.
function isApprovedByHumans(source: Fixture | null): boolean {
  if (!source) return false;
  const artifact = source.aprovacaoGolden;
  if (!artifact || typeof artifact.artefato !== 'string' || artifact.artefato.trim() === '') {
    return false;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(artifact.data ?? '')) return false;

  const aprovacoes = EXPECTED_ROUTES.map((route) => source.expected?.[route]?.aprovado_por);
  if (aprovacoes.some((value) => !APPROVERS.includes(value as Approver))) return false;
  return new Set(aprovacoes).size === APPROVERS.length;
}

function readFixture(): Fixture | null {
  try {
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
  } catch {
    return null;
  }
}

const fixture = readFixture();

// date é HTTP-date volátil: muda a cada resposta e quebraria o golden. Todo o resto,
// inclusive headers x-*, é preservado — exclusion não esconde header de segurança.
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

describe('golden "antes" — comportamento atual congelado (AUTH-01)', () => {
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

  it('whenGoldenBeforeCaptured_thenEveryCaseHasStatusBodyHeader', async () => {
    expect(fixture, 'fixture auth-before.fixture.json ausente — golden "antes" não capturado')
      .not.toBeNull();
    const golden = fixture as Fixture;
    expect(Object.keys(golden.casos).sort(), 'casos do golden').toEqual([...CASE_IDS].sort());

    for (const id of CASE_IDS) {
      const saved = golden.casos[id].snapshot;
      expect(saved, `${id}: snapshot ausente`).toBeDefined();
      expect(typeof saved.status, `${id}: status`).toBe('number');
      expect(saved.body, `${id}: body ausente`).toBeDefined();
      expect(Object.keys(saved.headers).length, `${id}: headers ausentes`).toBeGreaterThan(0);

      const live = await capture(id);
      expect(live.status, `${id}: status divergiu do golden`).toBe(saved.status);
      expect(live.body, `${id}: body divergiu do golden`).toEqual(saved.body);
      expect(live.headers, `${id}: headers divergiram do golden`).toEqual(saved.headers);
    }

    expect(Object.keys(golden.casos['sem token'].snapshot.headers)).not.toContain('date');
    expect(golden.normalizacao.excluidos.date, 'justificativa de date').toContain('volátil');
    const savedSecurityHeaders = Object.keys(golden.casos.admin.snapshot.headers)
      .filter((header) => header.startsWith('x-'));
    const liveAdmin = await capture('admin');
    for (const header of savedSecurityHeaders) {
      expect(liveAdmin.headers[header], `header ${header} preservado`).toBe(
        golden.casos.admin.snapshot.headers[header],
      );
    }
  });
});

describe('guarda de aprovação humana (AUTH-01)', () => {
  const assinatura = {
    aprovado_por: 'qa-engineer',
    data: '2026-11-24',
    artefato: '.spec/prd/auth-sessao-cliente/aprovacao-golden.md',
  };

  function comAprovacao(aprovado_por: string): Fixture {
    const base = fixture as Fixture;
    return {
      ...base,
      aprovacaoGolden: { ...assinatura },
      expected: Object.fromEntries(
        EXPECTED_ROUTES.map((route, index) => [
          route,
          { ...base.expected[route], aprovado_por: index === 0 ? aprovado_por : APPROVERS[1] },
        ]),
      ),
    };
  }

  it('whenForgedApproverPlanted_thenGuardStaysLocked', () => {
    expect(isApprovedByHumans(comAprovacao('backend-engineer'))).toBe(false);
    expect(isApprovedByHumans(comAprovacao('eu'))).toBe(false);
    expect(isApprovedByHumans(comAprovacao(PENDING_APPROVAL))).toBe(false);
  });

  it('whenBothAllowListedApproversPlantedInMemory_thenGuardUnlocks', () => {
    // Somente em memória: a fixture permanece pendente; nenhuma assinatura é gravada.
    expect(isApprovedByHumans(comAprovacao(APPROVERS[0]))).toBe(true);
  });

  it('whenSignatureArtifactMissing_thenGuardStaysLocked', () => {
    const source = comAprovacao(APPROVERS[0]);
    delete source.aprovacaoGolden.artefato;
    expect(isApprovedByHumans(source)).toBe(false);
  });
});

// Rotas novas não têm "antes real": expected vem de aprovação humana, nunca de comparação
// contra vazio. Enquanto pendente, suíte fica SUSPENSA com reason explícita — não verde forjado.
const expectedFromFixture = fixture?.expected ?? {};
const humanoAprovou = isApprovedByHumans(fixture);

describe.skipIf(!humanoAprovou)(
  'expected de rotas novas — SUSPENSO: pendente de aprovacao humana (2026-11-24)',
  () => {
    it('whenExpectedForNewRoutes_thenApprovedByHumans', () => {
      if (!isApprovedByHumans(fixture)) {
        throw new Error(
          `esperado aprovado ausente (${PENDING_APPROVAL}) — exige ${APPROVERS.join(' + ')} e artefato de assinatura datado; comparar contra vazio é defeito`,
        );
      }
      for (const route of EXPECTED_ROUTES) {
        const item = expectedFromFixture[route];
        expect(Object.keys(item.proposto).length, `${route}: expected não vazio`).toBeGreaterThan(0);
        expect(typeof item.proposto.status, `${route}: status`).toBe('number');
        expect(item.data, `${route}: data`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  },
);
