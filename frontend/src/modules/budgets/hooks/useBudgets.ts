import { useMemo, useState } from 'react'
import type { BudgetView } from '../model/budget.adapter'

// O1.4 — hook-first: busca por categoria + ordenação A→Z fora do JSX.
// KPIs sempre globais (ignoram filtro) — mesmo contrato de useCategories.

export type BudgetStatusFilter = 'all' | 'ok' | 'warning' | 'over'

export interface BudgetKpis {
  count: number
  totalLimitCents: number
  totalSpentCents: number
  /** basis points (0..10000+) — inteiro p/ display, sem float de dinheiro. */
  percentBps: number
  overCount: number
}

const EMPTY_KPIS: BudgetKpis = {
  count: 0,
  totalLimitCents: 0,
  totalSpentCents: 0,
  percentBps: 0,
  overCount: 0,
}

export function useBudgets(budgets: BudgetView[] = []) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<BudgetStatusFilter>('all')

  const kpis = useMemo<BudgetKpis>(() => {
    if (budgets.length === 0) return EMPTY_KPIS
    let totalLimitCents = 0
    let totalSpentCents = 0
    let overCount = 0
    for (const budget of budgets) {
      totalLimitCents += budget.limitCents
      totalSpentCents += budget.spentCents
      if (budget.status === 'over') overCount += 1
    }
    return {
      count: budgets.length,
      totalLimitCents,
      totalSpentCents,
      percentBps:
        totalLimitCents === 0
          ? 0
          : Math.round((totalSpentCents * 10000) / totalLimitCents),
      overCount,
    }
  }, [budgets])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return budgets
      .filter((budget) => {
        if (statusFilter !== 'all' && budget.status !== statusFilter) return false
        if (query && !(budget.categoryName ?? '').toLowerCase().includes(query)) return false
        return true
      })
      .sort((a, b) =>
        (a.categoryName ?? a.categoryId).localeCompare(b.categoryName ?? b.categoryId, 'pt-BR'),
      )
  }, [budgets, search, statusFilter])

  const isEmpty = budgets.length === 0
  const isFilteredEmpty = !isEmpty && filtered.length === 0

  return {
    search,
    setSearch,
    statusFilter,
    setStatusFilter,
    kpis,
    filtered,
    isEmpty,
    isFilteredEmpty,
  }
}
