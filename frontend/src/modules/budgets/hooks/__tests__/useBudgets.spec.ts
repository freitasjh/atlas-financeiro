// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBudgets } from '../useBudgets'
import type { BudgetView } from '../../model/budget.adapter'

function view(overrides: Partial<BudgetView> = {}): BudgetView {
  return {
    id: 'b1',
    categoryId: 'c1',
    categoryName: 'Alimentação',
    month: '2026-11-01',
    limitCents: 10000,
    spentCents: 0,
    status: 'ok',
    ...overrides,
  }
}

const seed: BudgetView[] = [
  view({ id: 'b1', categoryId: 'c1', categoryName: 'Moradia', limitCents: 10000, spentCents: 5000, status: 'ok' }),
  view({ id: 'b2', categoryId: 'c2', categoryName: 'Alimentação', limitCents: 10000, spentCents: 8500, status: 'warning' }),
  view({ id: 'b3', categoryId: 'c3', categoryName: 'Lazer', limitCents: 5000, spentCents: 6000, status: 'over' }),
]

// O1.4 — hook useBudgets: busca, ordenação, status, KPIs (total/limite/gasto/%/estourados).

describe('whenBudgetsAreFiltered_thenSearchMatchesCategoryName', () => {
  it('lista ordenada A→Z por nome da categoria', () => {
    const { result } = renderHook(() => useBudgets(seed))
    expect(result.current.filtered.map((b) => b.categoryName)).toEqual([
      'Alimentação',
      'Lazer',
      'Moradia',
    ])
  })

  it('busca filtra por nome (case-insensitive)', () => {
    const { result } = renderHook(() => useBudgets(seed))
    act(() => result.current.setSearch('laz'))
    expect(result.current.filtered.map((b) => b.categoryName)).toEqual(['Lazer'])
  })
})

describe('whenBudgetKpisAreDerived_thenTotalsReflectAllViews', () => {
  it('total/limite/gasto/percentual/estourados (KPIs ignoram filtro)', () => {
    const { result } = renderHook(() => useBudgets(seed))
    act(() => result.current.setSearch('lazer'))
    expect(result.current.kpis).toEqual({
      count: 3,
      totalLimitCents: 25000,
      totalSpentCents: 19500,
      percentBps: 7800,
      overCount: 1,
    })
  })

  it('vazio retorna zeros (sem NaN)', () => {
    const { result } = renderHook(() => useBudgets([]))
    expect(result.current.kpis).toEqual({
      count: 0,
      totalLimitCents: 0,
      totalSpentCents: 0,
      percentBps: 0,
      overCount: 0,
    })
    expect(result.current.isEmpty).toBe(true)
  })
})
