import { useMemo, useState } from 'react'
import { computeTreasuryMetrics, type AccountViewItem } from '../model/view-model'

export type AccountsViewMode = 'statements' | 'grid'

// Hook-first: seleção, modo de visão e métricas em cents fora do JSX.
export function useAccountsView(accounts: AccountViewItem[], initialViewMode: AccountsViewMode = 'statements') {
  const [selectedAccountId, setSelectedAccountId] = useState<string>('')
  const [viewMode, setViewMode] = useState<AccountsViewMode>(initialViewMode)

  const activeAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId],
  )

  const metrics = useMemo(() => computeTreasuryMetrics(accounts), [accounts])

  return {
    selectedAccountId,
    setSelectedAccountId,
    activeAccount,
    viewMode,
    setViewMode,
    metrics,
  }
}
