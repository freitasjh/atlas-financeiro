import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  isPlanSlug,
  planCtaHref,
  registerCtaHref,
  resolvePlanSlug,
} from '../model/catalog'

const REGISTER_RE = /^\/register\?plano=(free|standard|pro|full)$/
const INVITE_RE = /^\/solicitar-convite\?plano=(free|standard|pro|full)$/

describe('whenRegisterCtaHrefEvaluated_thenAllowlistedSlugOnly', () => {
  it('slug válido gera destino de cadastro', () => {
    expect(registerCtaHref('full')).toBe('/register?plano=full')
    expect(registerCtaHref('free')).toBe('/register?plano=free')
    expect(registerCtaHref('standard')).toBe('/register?plano=standard')
    expect(registerCtaHref('pro')).toBe('/register?plano=pro')
  })

  it('slug forjado/ausente cai em free sem throw', () => {
    expect(registerCtaHref('forjado')).toBe('/register?plano=free')
    expect(registerCtaHref(undefined)).toBe('/register?plano=free')
    expect(registerCtaHref(null)).toBe('/register?plano=free')
    expect(registerCtaHref('')).toBe('/register?plano=free')
    expect(registerCtaHref(42)).toBe('/register?plano=free')
  })

  it('todo retorno casa a allowlist e nunca contém #', () => {
    for (const value of ['free', 'standard', 'pro', 'full', 'forjado', undefined, null]) {
      const href = registerCtaHref(value)
      expect(href, `href inválido para ${String(value)}`).toMatch(REGISTER_RE)
      expect(href, 'prefixo # é aplicado no call site').not.toContain('#')
    }
    expect(new Set(['free', 'standard', 'pro', 'full'].map((s) => registerCtaHref(s))).size).toBe(4)
  })
})

describe('whenLegacyHelpersAudited_thenInviteSemanticsFrozen', () => {
  it('planCtaHref continua CONVITE e não é o helper de cadastro', () => {
    expect(planCtaHref('full')).toBe('/solicitar-convite?plano=full')
    for (const slug of ['free', 'standard', 'pro', 'full'] as const) {
      expect(planCtaHref(slug)).toMatch(INVITE_RE)
      expect(planCtaHref(slug)).not.toBe(registerCtaHref(slug))
    }
  })

  it('allowlist e fallback permanecem exatos', () => {
    expect(isPlanSlug('standard')).toBe(true)
    expect(isPlanSlug('enterprise')).toBe(false)
    expect(resolvePlanSlug('enterprise')).toBe('free')
    expect(resolvePlanSlug(undefined)).toBe('free')
  })

  it('assinatura real de planCtaHref e pureza do catálogo preservadas', () => {
    const source = readFileSync('frontend/src/modules/landing/model/catalog.ts', 'utf8')
    expect(source, '🟡-4 assinatura congelada de planCtaHref').toContain(
      'export function planCtaHref(slug: PlanSlug): string {',
    )
    expect(source).toContain('return `/solicitar-convite?plano=${slug}`')
    expect(source, 'helper de cadastro ausente').toContain('export function registerCtaHref(value: unknown): string {')
    expect(source, 'window/React dentro do catálogo').not.toMatch(/\bwindow\b|\bReact\b|from ['"]react/)
  })
})
