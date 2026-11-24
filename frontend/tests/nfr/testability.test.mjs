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

describe('BIGBANG-14 — NFR-01: comportamento pinado antes/depois', () => {
  it('src/ inexistente e contrato v1 intacto no diff', () => {
    expect(existsSync(join(REPO_ROOT, 'src'))).toBe(false)
    expect(gitDiff(['backend/libs/shared-contracts/src/v1']).trim()).toBe('')
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

  it('0 teste que exija endpoint de login/refresh inventado', () => {
    const session = readFileSync(`${REPO_ROOT}/frontend/src/session/session.ts`, 'utf8')
    expect(session).not.toContain('/login')
    expect(session).not.toContain('/refresh')
    expect(gitDiff(['backend/apps']).trim()).toBe('')
  })
})
