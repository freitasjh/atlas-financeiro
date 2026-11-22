import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * CTA-13 (RF-13 / NFR-05, 🟡-3/🟡-1/🔵-1): `?plano=` é INTENÇÃO, nunca
 * autorização. O tenant_id vem do E2E real registrado pelo QA — nunca um
 * `count(*)` global, que daria falso positivo/negativo com tenants antigos.
 *
 * Sem arquivo de evidência = FALHA com mensagem clara. Sem skip.
 */
const HARNESS = 'harness/landing-dois-caminhos.json'
const STDOUT = 'harness/landing-dois-caminhos/evidence/e2e-stdout.json'

type SqlScoped = {
  tenantId: string
  assertion: string
  ok: boolean
  scopedRows: string
  globalCountUsed: boolean
}

type TenantDetail = {
  planId: string
  planSlug: string
  status: string
  trialEndsAt: string
  kind: string
}

let tenantId = ''
let sqlScoped: SqlScoped
let tenant: TenantDetail
let resolvedAssertion = ''

beforeAll(() => {
  let raw: string
  try {
    raw = readFileSync(HARNESS, 'utf8')
  } catch {
    throw new Error(
      `CTA-13: ${HARNESS} não encontrado — evidência do E2E é pré-condição do gate; execute o CTA-12 antes deste teste (sem skip)`,
    )
  }

  let report: {
    e2e?: {
      tenantId?: string
      sqlScoped?: SqlScoped
      guards?: { tenant?: { ok?: boolean; detail?: TenantDetail } }
    }
  }
  try {
    report = JSON.parse(raw)
  } catch {
    throw new Error(`CTA-13: ${HARNESS} é JSON inválido`)
  }

  tenantId = report.e2e?.tenantId ?? ''
  sqlScoped = report.e2e?.sqlScoped as SqlScoped
  tenant = report.e2e?.guards?.tenant?.detail as TenantDetail

  expect(tenantId, 'CTA-13: e2e.tenantId ausente').toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  )
  expect(sqlScoped, 'CTA-13: e2e.sqlScoped ausente').toBeTruthy()
  expect(tenant, 'CTA-13: e2e.guards.tenant.detail ausente').toBeTruthy()
  resolvedAssertion = (sqlScoped.assertion ?? '').replace('<capturado>', tenantId)
})

describe('whenPlanIntentFull_thenScopedSubscriptionIsFree', () => {
  it(' tenant_id do E2E é o mesmo do gate SQL escopado', () => {
    expect(sqlScoped.tenantId).toBe(tenantId)
    expect(sqlScoped.ok).toBe(true)
    expect(sqlScoped.globalCountUsed).toBe(false)
  })

  it('count(*)=1 escopado por tenant_id — nunca count global', () => {
    expect(resolvedAssertion).toContain('count(*)=1')
    expect(resolvedAssertion).toContain(`WHERE tenant_id='${tenantId}'`)
    expect(resolvedAssertion).toContain("plan_slug='free'")
    expect(resolvedAssertion).toContain("status='active'")
    expect(resolvedAssertion).toContain('trial_ends_at IS NULL')
    expect(resolvedAssertion, 'SELECT sem filtro de tenant_id = count global').toMatch(
      /WHERE\s+tenant_id='[0-9a-f-]{36}'/i,
    )
    expect(resolvedAssertion, 'nenhuma asserção de contagem global').not.toMatch(
      /count\(\*\)\s+FROM\s+public\.tenant_subscriptions\s*(?:;|$)/i,
    )
    expect(sqlScoped.scopedRows).toBe('1')
  })

  it('estado observado no E2E: free / active / trial NULL', () => {
    expect(tenant.planId).toBe('free')
    expect(tenant.planSlug).toBe('free')
    expect(tenant.status).toBe('active')
    expect(tenant.trialEndsAt).toBe('NULL')
    expect(tenant.kind).toBe('pf')
  })

  it('stdout do E2E confirma a mesma asserção escopada', () => {
    let stdout: { sql?: { ok?: boolean; scopedRows?: string; globalCountUsed?: boolean } }
    try {
      stdout = JSON.parse(readFileSync(STDOUT, 'utf8'))
    } catch {
      throw new Error(`CTA-13: ${STDOUT} não encontrado/inválido — evidência obrigatória (sem skip)`)
    }
    expect(stdout.sql?.ok).toBe(true)
    expect(stdout.sql?.scopedRows).toBe('1')
    expect(stdout.sql?.globalCountUsed).toBe(false)
  })

  it('allowlist no href: helper de cadastro não carrega autorização de plano', () => {
    const source = readFileSync('src/modules/landing/model/catalog.ts', 'utf8')
    expect(source).toContain('export function registerCtaHref(value: unknown): string {')
    expect(source).toContain('resolvePlanSlug(value)')
    expect(source, 'nenhum grant/autorização no catálogo').not.toMatch(
      /\bgrant\b|\bauthoriz|plan_intent\s*=|psp_/i,
    )
  })

  it('router.tsx continua read-only contra o sha256 registrado (não HEAD)', () => {
    const report = JSON.parse(readFileSync(HARNESS, 'utf8')) as {
      e2e?: { guards?: { routerReadOnly?: { detail?: { currentSha256?: string } } } }
    }
    const expected = report.e2e?.guards?.routerReadOnly?.detail?.currentSha256 ?? ''
    expect(expected, 'CTA-13: sha256 pré-ADR do router ausente no harness').toMatch(/^[0-9a-f]{64}$/)
    const actual = createHash('sha256')
      .update(readFileSync('src/router.tsx'))
      .digest('hex')
    expect(actual, 'router.tsx divergiu do snapshot pré-ADR — escalar ao architect, nunca editar').toBe(expected)
  })
})
