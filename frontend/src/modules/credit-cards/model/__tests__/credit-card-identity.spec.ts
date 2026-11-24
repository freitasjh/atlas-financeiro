// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CARD_THEMES,
  DEFAULT_CARD_THEME,
  creditCardRowToView,
  type CreditCardRow,
} from '../credit-card'

// ADR-001/ADR-003 (TDD): contrato de identidade PCI-safe.
// A paridade CHECK↔CARD_THEMES lê a migration congelada (não literal copiado).

const MIGRATION_PATH = resolve(process.cwd(), 'supabase/migrations/0047_credit_cards_identity.sql')
const ddlSql = readFileSync(MIGRATION_PATH, 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')

const legacyRow = {
  id: 'card-identity-1',
  user_id: 'user-identity-1',
  account_id: 'acc-identity-1',
  tenant_id: null,
  name: 'Cartão identidade',
  limit_cents: 500000,
  closing_day: 10,
  due_day: 17,
  created_at: '2026-11-17T00:00:00Z',
  updated_at: '2026-11-17T00:00:00Z',
} satisfies Omit<CreditCardRow, 'theme' | 'last4' | 'holder_name' | 'expiry_mm_aa' | 'is_default'>

function checkThemesFromMigration(): string[] {
  const match = /CHECK \(theme IN \(([^)]*)\)\)/.exec(ddlSql)
  if (!match) throw new Error('0047 sem CHECK de theme legível')
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('whenCardIdentityColumnsAreDeclared_thenMigrationIsPciSafeAndMatchesZod', () => {
  it('CARD_THEMES tem paridade exata com os valores do CHECK da migration 0047', () => {
    expect([...checkThemesFromMigration()].sort()).toEqual([...CARD_THEMES].sort())
  })

  it('DEFAULT do CHECK é platinum e pertence ao vocabulário', () => {
    expect(ddlSql).toMatch(/DEFAULT 'platinum'/)
    expect(CARD_THEMES).toContain(DEFAULT_CARD_THEME)
  })

  it('declara exatamente as cinco colunas de identidade, sem PAN/CVV/número completo', () => {
    const columns = [...ddlSql.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1])
    expect([...columns].sort()).toEqual(
      ['expiry_mm_aa', 'holder_name', 'is_default', 'last4', 'theme'].sort(),
    )
    for (const forbidden of ['pan', 'cvv', 'cvc', 'card_number', 'full_number']) {
      expect(columns).not.toContain(forbidden)
    }
  })

  it('é idempotente (IF NOT EXISTS em toda coluna)', () => {
    expect([...ddlSql.matchAll(/ADD COLUMN IF NOT EXISTS/g)]).toHaveLength(5)
  })
})

describe('whenCardIdentityRowIsAdapted_thenViewExposesPciSafeFields', () => {
  it('repassa last4 válido, titular, validade, tema e flag de principal', () => {
    const view = creditCardRowToView(
      {
        ...legacyRow,
        theme: 'emerald',
        last4: '1234',
        holder_name: 'JOAO SILVA',
        expiry_mm_aa: '12/29',
        is_default: true,
      },
      'visa',
    )

    expect(view.theme).toBe('emerald')
    expect(view.last4).toBe('1234')
    expect(view.holderName).toBe('JOAO SILVA')
    expect(view.expiryMmAA).toBe('12/29')
    expect(view.isDefault).toBe(true)
  })

  it('cai em null para last4 ausente, nulo ou fora de ^\\d{4}$', () => {
    for (const last4 of [undefined, null, '', '123', '12345', '12a4', ' 1234', '1234 ']) {
      expect(creditCardRowToView({ ...legacyRow, last4 }).last4).toBeNull()
    }
    expect(creditCardRowToView({ ...legacyRow, last4: '0000' }).last4).toBe('0000')
  })

  it('repassa titular/validade nulos e ausentes como null', () => {
    for (const holder_name of [undefined, null]) {
      for (const expiry_mm_aa of [undefined, null]) {
        const view = creditCardRowToView({ ...legacyRow, holder_name, expiry_mm_aa })
        expect(view.holderName).toBeNull()
        expect(view.expiryMmAA).toBeNull()
      }
    }
  })

  it('isDefault é boolean: true só quando a coluna é true', () => {
    for (const is_default of [undefined, null, false]) {
      expect(creditCardRowToView({ ...legacyRow, is_default }).isDefault).toBe(false)
    }
    expect(creditCardRowToView({ ...legacyRow, is_default: true }).isDefault).toBe(true)
  })

  it('cartão legado (sem colunas de identidade) mantém View compatível', () => {
    const view = creditCardRowToView(legacyRow)
    expect(view.last4).toBeNull()
    expect(view.holderName).toBeNull()
    expect(view.expiryMmAA).toBeNull()
    expect(view.isDefault).toBe(false)
    expect(view.theme).toBe(DEFAULT_CARD_THEME)
  })
})
