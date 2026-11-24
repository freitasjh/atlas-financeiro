// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCategories } from '../useCategories'
import type { CategoryView } from '../../model/category.adapter'

function view(overrides: Partial<CategoryView> = {}): CategoryView {
  return {
    id: 'c1',
    name: 'Alimentação',
    type: 'expense',
    color: null,
    isSystem: false,
    usageCount: 0,
    ...overrides,
  }
}

const seed: CategoryView[] = [
  view({ id: 'a', name: 'Moradia', type: 'expense', isSystem: true, usageCount: 5 }),
  view({ id: 'b', name: 'Salário', type: 'income', usageCount: 2 }),
  view({ id: 'c', name: 'Alimentação', type: 'expense', usageCount: 0 }),
]

// C1.4 — hook useCategories: busca/tipo AND, ordenação A→Z, contagens KPI.

describe('whenCategoriesAreFiltered_thenSearchAndTypeComposeWithAnd', () => {
  it('lista ordenada A→Z por padrão', () => {
    const { result } = renderHook(() => useCategories(seed))
    expect(result.current.filtered.map((c) => c.name)).toEqual([
      'Alimentação',
      'Moradia',
      'Salário',
    ])
  })

  it('busca filtra por nome (case-insensitive)', () => {
    const { result } = renderHook(() => useCategories(seed))
    act(() => result.current.setSearch('mor'))
    expect(result.current.filtered.map((c) => c.name)).toEqual(['Moradia'])
  })

  it('tipo filtra receitas/despesas e compõe AND com a busca', () => {
    const { result } = renderHook(() => useCategories(seed))
    act(() => result.current.setTypeFilter('income'))
    expect(result.current.filtered.map((c) => c.name)).toEqual(['Salário'])
    act(() => result.current.setSearch('sal'))
    expect(result.current.filtered.map((c) => c.name)).toEqual(['Salário'])
    act(() => result.current.setSearch('moradia'))
    expect(result.current.filtered).toHaveLength(0)
  })
})

describe('whenKpiCountsAreDerived_thenTotalsAreGlobal', () => {
  it('contagens ignoram filtros (sempre globais)', () => {
    const { result } = renderHook(() => useCategories(seed))
    act(() => {
      result.current.setSearch('moradia')
      result.current.setTypeFilter('expense')
    })
    expect(result.current.counts).toEqual({ total: 3, income: 1, expense: 2, system: 1 })
  })
})

describe('whenListsAreEmpty_thenEmptyFlagsAreCorrect', () => {
  it('lista vazia marca isEmpty sem isFilteredEmpty', () => {
    const { result } = renderHook(() => useCategories([]))
    expect(result.current.isEmpty).toBe(true)
    expect(result.current.isFilteredEmpty).toBe(false)
  })

  it('filtro sem resultado marca isFilteredEmpty', () => {
    const { result } = renderHook(() => useCategories(seed))
    act(() => result.current.setSearch('zzz'))
    expect(result.current.isEmpty).toBe(false)
    expect(result.current.isFilteredEmpty).toBe(true)
  })
})
