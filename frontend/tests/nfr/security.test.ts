// DEBT-SUPABASE — gate de dívida localizada (ADR-002)
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { tokenMatchesApp, type AppIdentity } from '../../src/session/session'
import { DEBT_MARKER, frontendPath, REPO_ROOT, secretPatternHits, sectionOf, specText } from '../helpers/scan'

const a: AppIdentity = { context: 'cliente', issuer: 'iss-a', audience: 'aud-a' }
const b: AppIdentity = { context: 'control-plane', issuer: 'iss-b', audience: 'aud-b' }

describe('BIGBANG-15 — NFR-02: 0 segredo, dívida localizada (não ausente)', () => {
  it('iss/aud por app: token de operador não serve no cliente', () => {
    const enc = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const token = `${enc({ alg: 'ES256' })}.${enc({ iss: a.issuer, aud: a.audience, context: a.context })}.sig`
    expect(tokenMatchesApp(token, a)).toBe(true)
    expect(tokenMatchesApp(token, b)).toBe(false)
  })

  it('zero padrão de credencial em frontend/ e no bundle', () => {
    expect(secretPatternHits()).toEqual([])
  })

  it('a dívida existe e está documentada — nunca alegar ausência de acoplamento', () => {
    const doc = frontendPath('docs/debt-supabase.md')
    expect(existsSync(doc)).toBe(true)
    expect(DEBT_MARKER).toContain('SUPABASE')
    const text = specText()
    expect(text).toContain('nunca "isolamento verificado"')
    expect(text.toLowerCase().includes('frontend desacoplado')).toBe(true)
  })

  it('F4 (CSP/_headers/check-dist) permanece registrada, não executada', () => {
    expect(existsSync(frontendPath('public', '_headers'))).toBe(false)
    const sec12 = sectionOf(specText(), 12)
    expect(sec12).toContain('registrada, não executada')
    expect(existsSync(`${REPO_ROOT}/public/_headers`)).toBe(true)
  })
})
