// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BRAND_TOKEN_FALLBACK,
  brandTokenFor,
  BRAND_TOKENS,
} from '../brand-tokens'

const ROOT = join(process.cwd(), 'frontend', 'src')

const HEX = /#[0-9a-fA-F]{3,8}\b/

function source(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

describe('whenBrandTokensAreDeclared_thenTheyContainOnlySemanticClasses', () => {
  it('nenhum valor carrega hex cru (C-S7)', () => {
    const values = [BRAND_TOKEN_FALLBACK, ...Object.values(BRAND_TOKENS)]
    expect(values.length).toBeGreaterThan(1)
    values.forEach((value) => {
      expect(value).not.toMatch(HEX)
      expect(value.trim().length).toBeGreaterThan(0)
    })
  })

  it('fallback é neutro e institucional conhecido resolve pelo mapa (C-S7)', () => {
    expect(BRAND_TOKEN_FALLBACK).toContain('bg-muted')
    expect(brandTokenFor('itau')).toBe(BRAND_TOKENS.itau)
    expect(brandTokenFor('institution-unknown' as never)).toBe(BRAND_TOKEN_FALLBACK)
  })

  it('cada token de marca tem fundo, texto e borda (C-S7)', () => {
    Object.values(BRAND_TOKENS).forEach((value) => {
      expect(value).toMatch(/\bbg-/)
      expect(value).toMatch(/\btext-/)
      expect(value).toMatch(/\bborder-/)
    })
  })
})

describe('whenComponentsRenderBrandIdentity_thenNoRawHexRemains', () => {
  it('bank-account-card da vitrine não carrega #64748b (C-S7)', () => {
    const text = source('components/shadcn/bank-accounts/bank-account-card.tsx')
    expect(text).not.toContain('#64748b')
  })

  it('view-model da camada real consome o mapa de tokens (C-S7)', () => {
    const model = source('modules/accounts/model/view-model.ts')
    expect(model).toContain('brand-tokens')
    expect(model).not.toMatch(HEX)
  })

  it('componentes de /contas não declaram hex solto (C-S7)', () => {
    const files = [
      'modules/accounts/components/AccountCard.tsx',
      'modules/accounts/components/SelectorBar.tsx',
      'modules/accounts/components/TreasuryHeader.tsx',
      'modules/accounts/components/SummaryHeader.tsx',
    ]
    files.forEach((file) => {
      expect(source(file)).not.toMatch(HEX)
    })
  })
})
