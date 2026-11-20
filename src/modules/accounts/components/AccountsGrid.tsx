import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers, Building2, TrendingUp, CreditCard, Banknote, Plus } from 'lucide-react'
import { AccountCard } from './AccountCard'
import { cn } from '@/lib/cn'
import type { AccountType, AccountViewItem } from '../model/view-model'

interface AccountsGridProps {
  accounts: AccountViewItem[]
  selectedAccountId: string
  onSelectAccount: (account: AccountViewItem) => void
  onOpenNewAccount: () => void
  onTransferFrom?: (account: AccountViewItem) => void
  onImportOFX?: (account: AccountViewItem) => void
  onEdit?: (account: AccountViewItem) => void
  onDelete?: (account: AccountViewItem) => void
}

type FilterType = 'all' | AccountType

const FILTER_TABS: Array<{ id: FilterType; labelKey: string; icon: typeof Layers }> = [
  { id: 'all', labelKey: 'accounts.grid.all', icon: Layers },
  { id: 'checking', labelKey: 'accounts.grid.checking', icon: Building2 },
  { id: 'investment', labelKey: 'accounts.grid.investment', icon: TrendingUp },
  { id: 'wallet', labelKey: 'accounts.grid.wallet', icon: CreditCard },
  { id: 'physical_cash', labelKey: 'accounts.grid.physicalCash', icon: Banknote },
]

export function AccountsGrid({
  accounts,
  selectedAccountId,
  onSelectAccount,
  onOpenNewAccount,
  onTransferFrom,
  onImportOFX,
  onEdit,
  onDelete,
}: AccountsGridProps) {
  const { t } = useTranslation()
  const [activeFilter, setActiveFilter] = useState<FilterType>('all')

  const filteredAccounts = accounts.filter((account) => {
    if (activeFilter === 'all') return true
    return account.type === activeFilter
  })

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/80 bg-muted/20 p-8 text-center">
        <p className="text-sm font-bold text-foreground">{t('accounts.empty')}</p>
        <p className="text-xs text-muted-foreground mt-1">{t('accounts.emptyHint')}</p>
        <button
          type="button"
          onClick={onOpenNewAccount}
          className="mt-4 inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"
        >
          <Plus className="h-4 w-4" />
          {t('accounts.grid.add')}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
          {FILTER_TABS.map((tab) => {
            const Icon = tab.icon
            const isSelected = activeFilter === tab.id
            const count = tab.id === 'all' ? accounts.length : accounts.filter((a) => a.type === tab.id).length

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveFilter(tab.id)}
                aria-pressed={isSelected}
                className={cn(
                  'flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all border',
                  isSelected
                    ? 'bg-primary text-primary-foreground border-primary shadow-xs'
                    : 'bg-muted/40 text-muted-foreground border-border/70 hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span>{t(tab.labelKey)}</span>
                <span
                  className={cn(
                    'ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-mono tabular-nums',
                    isSelected ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        <span className="text-xs text-muted-foreground self-end sm:self-auto tabular-nums">
          {t(filteredAccounts.length === 1 ? 'accounts.grid.countOne' : 'accounts.grid.countMany', {
            count: filteredAccounts.length,
          })}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filteredAccounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            isSelected={account.id === selectedAccountId}
            onSelect={onSelectAccount}
            onTransferFrom={onTransferFrom}
            onImportOFX={onImportOFX}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}

        <div
          data-testid="accounts-grid-add-hint"
          className="flex min-h-[160px] flex-col items-center justify-center rounded-2xl border border-dashed border-border/80 bg-muted/20 p-6 text-center"
        >
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Plus className="h-5 w-5" />
          </div>
          <span className="text-xs font-semibold text-foreground">{t('accounts.grid.add')}</span>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('accounts.grid.addHint')}</p>
        </div>
      </div>
    </div>
  )
}
