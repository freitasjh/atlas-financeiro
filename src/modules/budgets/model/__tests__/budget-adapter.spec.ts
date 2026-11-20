// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  toBudgetView,
  withSpending,
  budgetStatus,
  type BudgetView,
  type BudgetRowLike,
} from '../budget.adapter'

// O1.1 — adapter Row↔View + gasto agregado (sem N+1) + semáforo ok|warning|over.

function row(overrides: Partial<BudgetRowLike> = {}): BudgetRowLike {
  return {
    id: 'b1',
    user_id: 'u1',
    category_id: 'c1',
    month: '2026-11-01',
    limit_cents: 10000,
    ...overrides,
  }
}

describe('whenBudgetRowIsAdapted_thenViewExposesCentsWithZeroSpent', () => {
  it('mapeia linha para view com spent 0 e status ok', () => {
    const view = toBudgetView(row())
    expect(view).toMatchObject({
      id: 'b1',
      categoryId: 'c1',
      month: '2026-11-01',
      limitCents: 10000,
      spentCents: 0,
      status: 'ok',
    })
  })
})

describe('whenSpendingIsAttached_thenSinglePassWithoutNPlusOne', () => {
  it('anexa gasto por categoria em passada única e deriva status', () => {
    const views: BudgetView[] = [toBudgetView(row()), toBudgetView(row({ id: 'b2', category_id: 'c2' }))]
    const txs = [
      { category_id: 'c1', amount_cents: 5000 },
      { category_id: 'c1', amount_cents: 4000 },
      { category_id: 'c2', amount_cents: 11000 },
      { category_id: null, amount_cents: 999 },
    ]
    const result = withSpending(views, txs)
    expect(result.find((v) => v.categoryId === 'c1')).toMatchObject({
      spentCents: 9000,
      status: 'warning',
    })
    expect(result.find((v) => v.categoryId === 'c2')).toMatchObject({
      spentCents: 11000,
      status: 'over',
    })
  })
})

describe('whenBudgetStatusIsDerived_thenThresholdsAreOkWarningOver', () => {
  it('ok abaixo de 80%', () => {
    expect(budgetStatus(7999, 10000)).toBe('ok')
  })

  it('warning a partir de 80% (inclusive)', () => {
    expect(budgetStatus(8000, 10000)).toBe('warning')
    expect(budgetStatus(10000, 10000)).toBe('warning')
  })

  it('over acima de 100% (1 centavo estoura)', () => {
    expect(budgetStatus(10001, 10000)).toBe('over')
  })
})
