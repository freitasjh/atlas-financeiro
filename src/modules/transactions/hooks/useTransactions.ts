import { useMemo, useState } from 'react'
import type { TransactionView } from '../model/view-model'

export type TransactionsViewMode = 'table' | 'list'

export interface UseTransactionsOptions {
  pageSize?: number
}

// Hook-first: filtros (busca, tipo, status, período) + paginação fora do JSX.
export function useTransactions(
  transactions: TransactionView[] = [],
  options: UseTransactionsOptions = {},
) {
  const pageSize = options.pageSize ?? 20
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => {
    return transactions.filter((tx) => {
      if (search.trim()) {
        const q = search.toLowerCase()
        const matches =
          tx.description.toLowerCase().includes(q) ||
          (tx.categoryName ?? '').toLowerCase().includes(q)
        if (!matches) return false
      }
      if (typeFilter !== 'all' && tx.type !== typeFilter) return false
      if (statusFilter !== 'all' && tx.status !== statusFilter) return false
      if (from && tx.date < from) return false
      if (to && tx.date > to) return false
      return true
    })
  }, [transactions, search, typeFilter, statusFilter, from, to])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  const isEmpty = transactions.length === 0
  const isFilteredEmpty = !isEmpty && filtered.length === 0

  return {
    search,
    setSearch,
    typeFilter,
    setTypeFilter,
    statusFilter,
    setStatusFilter,
    from,
    setFrom,
    to,
    setTo,
    page: safePage,
    setPage,
    pageSize,
    totalPages,
    filtered,
    paginated,
    isEmpty,
    isFilteredEmpty,
  }
}
