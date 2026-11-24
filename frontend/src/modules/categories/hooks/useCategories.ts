import { useMemo, useState } from 'react'
import type { CategoryView } from '../model/category.adapter'

export type CategoryTypeFilter = 'all' | 'income' | 'expense'

// C1.4 — hook-first: filtros (busca + tipo com AND) + ordenação A→Z fora do JSX.
// Contagens KPI sempre globais (ignoram filtros) — SPEC RF-02.

export interface CategoryKpiCounts {
  total: number
  income: number
  expense: number
  system: number
}

export function useCategories(categories: CategoryView[] = []) {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<CategoryTypeFilter>('all')

  const counts = useMemo<CategoryKpiCounts>(() => {
    let income = 0
    let expense = 0
    let system = 0
    for (const category of categories) {
      if (category.type === 'income') income += 1
      else expense += 1
      if (category.isSystem) system += 1
    }
    return { total: categories.length, income, expense, system }
  }, [categories])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return categories
      .filter((category) => {
        if (typeFilter !== 'all' && category.type !== typeFilter) return false
        if (query && !category.name.toLowerCase().includes(query)) return false
        return true
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  }, [categories, search, typeFilter])

  const isEmpty = categories.length === 0
  const isFilteredEmpty = !isEmpty && filtered.length === 0

  return {
    search,
    setSearch,
    typeFilter,
    setTypeFilter,
    counts,
    filtered,
    isEmpty,
    isFilteredEmpty,
  }
}
