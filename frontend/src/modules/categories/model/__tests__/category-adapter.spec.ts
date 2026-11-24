import { describe, expect, it } from 'vitest'
import { toCategoryView, withUsageCounts } from '../category.adapter'
import type { Database } from '@/types/supabase'

type CategoryRow = Database['public']['Tables']['categories']['Row']

function row(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: 'c1',
    user_id: 'u1',
    parent_id: null,
    name: 'Alimentação',
    type: 'expense',
    icon_code: null,
    color_hex: '#ff0808',
    spending_limit_cents: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

// C1.1 — adapter Row↔View.

describe('whenCategoryRowIsAdapted_thenViewExposesOnlyUiContract', () => {
  it('mapeia color_hex para color e zera usageCount por padrão', () => {
    const view = toCategoryView(row())
    expect(view).toMatchObject({
      id: 'c1',
      name: 'Alimentação',
      type: 'expense',
      color: '#ff0808',
      isSystem: false,
      usageCount: 0,
    })
  })

  it('color_hex nulo vira color nula', () => {
    expect(toCategoryView(row({ color_hex: null })).color).toBeNull()
  })

  it('nunca expõe parent_id nem colunas internas (modelo plano)', () => {
    const view = toCategoryView(row({ parent_id: 'p1' }))
    expect(view).not.toHaveProperty('parent_id')
    expect(view).not.toHaveProperty('color_hex')
    expect(view).not.toHaveProperty('user_id')
  })
})

describe('whenUsageMapIsApplied_thenViewsCarryCountsWithoutExtraQueries', () => {
  it('anexa usageCount do Map, default 0 para ausentes', () => {
    const views = [toCategoryView(row({ id: 'a' })), toCategoryView(row({ id: 'b' }))]
    const result = withUsageCounts(views, new Map([['a', 3]]))
    expect(result.find((v) => v.id === 'a')?.usageCount).toBe(3)
    expect(result.find((v) => v.id === 'b')?.usageCount).toBe(0)
  })
})
