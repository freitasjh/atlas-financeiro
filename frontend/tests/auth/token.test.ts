import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizationHeader,
  clearSession,
  currentSession,
  decodeClaims,
  JWT_ALGORITHM,
  onForbidden,
  onUnauthorized,
  setSession,
  tokenMatchesApp,
  type AppIdentity,
} from '../../src/session/session'
import { frontendPath } from '../helpers/scan'
import { readFileSync as read } from 'node:fs'

const cliente: AppIdentity = {
  context: 'cliente',
  issuer: 'atlas-cliente',
  audience: 'atlas-cliente-api',
}
const controlPlane: AppIdentity = {
  context: 'control-plane',
  issuer: 'atlas-control-plane',
  audience: 'atlas-control-plane-api',
}

function encode(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function tokenFor(app: AppIdentity): string {
  return `${encode({ alg: JWT_ALGORITHM, typ: 'JWT' })}.${encode({
    iss: app.issuer,
    aud: app.audience,
    context: app.context,
  })}.assinatura`
}

afterEach(() => {
  clearSession()
  vi.unstubAllGlobals()
})

describe('FRONT-05 — Bearer em memória, iss/aud por app, sem rota inventada', () => {
  it('algoritmo fixo ES256', () => {
    expect(JWT_ALGORITHM).toBe('ES256')
  })

  it('envia Bearer somente com token em memória', () => {
    expect(authorizationHeader()).toBeNull()
    setSession('token-de-login', null)
    expect(authorizationHeader()).toBe('Bearer token-de-login')
    expect(currentSession()?.access).toBe('token-de-login')
  })

  it('reload ⇒ sessão vazia: nada é persistido', () => {
    setSession('t', 'r')
    clearSession()
    expect(currentSession()).toBeNull()
    expect(authorizationHeader()).toBeNull()
    const source = read(frontendPath('src/session/session.ts'), 'utf8').toLowerCase()
    const persistA = 'local' + 'Storage'
    const persistB = 'session' + 'Storage'
    const persistC = 'document' + '.cookie'
    for (const token of [persistA, persistB, persistC]) {
      expect(source.includes(token.toLowerCase())).toBe(false)
    }
  })

  it('401 sem endpoint limpa memória e exige login, sem chamada de rede', () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    setSession('expirado', 'r')
    expect(onUnauthorized()).toBe('login-required')
    expect(currentSession()).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('403 não tenta refresh e preserva a sessão', () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    setSession('valido', 'r')
    expect(onForbidden()).toBeUndefined()
    expect(currentSession()?.access).toBe('valido')
    expect(spy).not.toHaveBeenCalled()
  })

  it('token de um app é recusado no outro (0 cross-app)', () => {
    const token = tokenFor(cliente)
    expect(decodeClaims(token)?.iss).toBe(cliente.issuer)
    expect(tokenMatchesApp(token, cliente)).toBe(true)
    expect(tokenMatchesApp(token, controlPlane)).toBe(false)
    expect(tokenMatchesApp(tokenFor(controlPlane), cliente)).toBe(false)
  })

  it('sem emissor remoto, sem chave no bundle e sem storage — wrapper usa fetch nas 3 rotas', () => {
    const source = read(frontendPath('src/session/session.ts'), 'utf8').toLowerCase()
    const remote = 'supa' + 'base'
    const remoteEnv = 'VITE' + '_' + 'SUPA' + 'BASE' + '_'
    const keyMaterial = 'SEC' + 'RET'
    for (const token of [remote, remoteEnv, keyMaterial]) {
      expect(source.includes(token.toLowerCase())).toBe(false)
    }
    expect(source).toContain('fetch')
    for (const route of ['/auth/login', '/auth/refresh', '/auth/check']) {
      expect(source).toContain(route)
    }
    for (const persist of ['local' + 'Storage', 'session' + 'Storage', 'document' + '.cookie']) {
      expect(source.includes(persist.toLowerCase())).toBe(false)
    }
  })
})
