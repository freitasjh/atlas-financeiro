import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { healthStatusSchema } from '../../src/contract/v1.ts'
import {
  authorizationHeader,
  JWT_ALGORITHM,
  setSession,
  tokenMatchesApp,
  clearSession,
} from '../../src/session/session.ts'
import { gitDiff, REPO_ROOT } from '../helpers/scan.ts'

// ADR-001 §3/§4: fronteira autorizada; `src/database` cobre tokens/providers nomeados.
const ALLOWED_AUTH_PATHS = [
  'backend/apps/cliente/src/auth',
  'backend/apps/cliente/src/database',
  'backend/apps/cliente/test',
  'backend/libs/shared-contracts/src/v1',
  'frontend/src',
  'frontend/docs',
  'frontend/tests',
  'workflow-state.json',
]
const PROTECTED_PATHS = [
  '.opencode/plugins',
  'scripts',
  'harness.config.json',
  'backend/apps/control-plane',
]

function diffPaths(diff) {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('diff --git '))
    .map((line) => line.match(/ b\/(.+)$/)?.[1] ?? '')
    .filter(Boolean)
}

function outsideAllowList(diff) {
  return diffPaths(diff).filter(
    (path) => !ALLOWED_AUTH_PATHS.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)),
  )
}

describe('BIGBANG-14 — NFR-01: comportamento pinado antes/depois', () => {
  it('src/ inexistente e contrato v1 aditivo no diff (ADR-001 §3)', () => {
    expect(existsSync(join(REPO_ROOT, 'src'))).toBe(false)
    const removed = gitDiff(['backend/libs/shared-contracts/src/v1'])
      .split('\n')
      .filter((line) => line.startsWith('-') && !line.startsWith('---'))
    expect(removed, 'v1 é aditivo: nenhum schema congelado pode ser removido').toEqual([])
  })

  it('portas: 5173 no root, porta legada extinta, Nest 3001/3002', () => {
    const cfg = readFileSync(`${REPO_ROOT}/vite.config.ts`, 'utf8')
    expect(cfg).toContain('5173')
    expect(cfg.includes('517' + '4')).toBe(false)
    for (const app of ['cliente', 'control-plane']) {
      const main = readFileSync(`${REPO_ROOT}/backend/apps/${app}/src/main.ts`, 'utf8')
      expect(main).toMatch(/300[12]/)
    }
  })

  it('negativo de strictObject e negação de token cruzado', () => {
    expect(() => healthStatusSchema.parse({ status: 'ok', db: 'up', context: 'x', extra: 1 })).toThrow()
    const enc = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const token = `${enc({ alg: JWT_ALGORITHM })}.${enc({
      iss: 'cliente',
      aud: 'cliente-api',
      context: 'cliente',
    })}.sig`
    expect(tokenMatchesApp(token, { context: 'cliente', issuer: 'cliente', audience: 'cliente-api' })).toBe(true)
    expect(tokenMatchesApp(token, { context: 'control-plane', issuer: 'cp', audience: 'cp-api' })).toBe(false)
    setSession('abc', null)
    expect(authorizationHeader()).toBe('Bearer abc')
    clearSession()
  })

  it('allow-list de fronteira: fixture aprova paths ADR-001 e barra os protegidos', () => {
    const fixture = [
      'diff --git a/frontend/tests/auth/x.spec.tsx b/frontend/tests/auth/x.spec.tsx',
      'diff --git a/backend/libs/shared-contracts/src/v1/index.ts b/backend/libs/shared-contracts/src/v1/index.ts',
      'diff --git a/backend/apps/control-plane/src/main.ts b/backend/apps/control-plane/src/main.ts',
      'diff --git a/scripts/build-tokens.mjs b/scripts/build-tokens.mjs',
    ].join('\n')
    expect(outsideAllowList(fixture)).toEqual([
      'backend/apps/control-plane/src/main.ts',
      'scripts/build-tokens.mjs',
    ])
  })

  it('0 rota inventada: wrapper usa exatamente as 3 rotas ADR-001', () => {
    const session = readFileSync(`${REPO_ROOT}/frontend/src/session/session.ts`, 'utf8')
    for (const route of ['/auth/login', '/auth/refresh', '/auth/check']) {
      expect(session, `rota ${route} ausente do wrapper`).toContain(route)
    }
    for (const invented of ['/auth/sign-in', '/auth/logout', '/auth/signup']) {
      expect(session, `rota inventada ${invented}`).not.toContain(invented)
    }
    expect(gitDiff(PROTECTED_PATHS).trim(), 'gate.js/scripts/harness/control-plane intocados').toBe('')
    expect(
      outsideAllowList(gitDiff(['backend', 'frontend', 'workflow-state.json'])),
      'diff fora da allow-list ADR-001',
    ).toEqual([])
  })
})
