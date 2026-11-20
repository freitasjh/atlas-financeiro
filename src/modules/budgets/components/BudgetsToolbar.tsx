import { useTranslation } from 'react-i18next'
import { Plus, Search } from 'lucide-react'
import { Button } from '@/components/shadcn/ui/button'
import { Input } from '@/components/shadcn/ui/input'
import { MonthYearPicker } from '@/components/shadcn/ui/month-year-picker'
import { PillToggle, type PillToggleOption } from '@/components/shadcn/ui/pill-toggle'
import type { BudgetStatusFilter } from '../hooks/useBudgets'

// O2.1/O2.4 — toolbar <search>: busca + seletor de mês + CTA único
// (Regra da Ação Única). Mês sempre dia 01 (espelha budgets_month_first_day).

export function shiftMonth(month: string, delta: number): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-01$/.exec(month)
  if (!match) throw new Error('invalid-month')
  const total = Number(match[1]) * 12 + (Number(match[2]) - 1) + delta
  const year = Math.floor(total / 12)
  const m = String((total % 12) + 1).padStart(2, '0')
  return `${year}-${m}-01`
}

export function formatMonthLabel(month: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})-01$/.exec(month)
  if (!match) return month
  const dt = new Date(Number(match[1]), Number(match[2]) - 1, 1)
  const label = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(dt)
  return label.charAt(0).toUpperCase() + label.slice(1)
}

interface BudgetsToolbarProps {
  query: string
  onQueryChange: (query: string) => void
  month: string
  onMonthChange: (month: string) => void
  onNew: () => void
  statusFilter?: BudgetStatusFilter
  onStatusFilterChange?: (filter: BudgetStatusFilter) => void
  actions?: React.ReactNode
}

export function BudgetsToolbar({
  query,
  onQueryChange,
  month,
  onMonthChange,
  onNew,
  statusFilter,
  onStatusFilterChange,
  actions,
}: BudgetsToolbarProps) {
  const { t } = useTranslation()

  const statusOptions: PillToggleOption<BudgetStatusFilter>[] = [
    { value: 'all', label: t('common.all', 'Todos') },
    { value: 'ok', label: t('budgets.filterOk', 'No limite') },
    { value: 'warning', label: t('budgets.filterWarn', 'Em alerta') },
    { value: 'over', label: t('budgets.filterExceeded', 'Excedidos') },
  ]

  return (
    <search
      role="search"
      aria-label={t('budgets.toolbarLabel')}
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={t('budgets.searchLabel')}
            placeholder={t('budgets.searchPlaceholder')}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>

        <MonthYearPicker
          value={month}
          aria-label={t('budgets.monthLabel')}
          onChange={(value) => onMonthChange(`${value.isoString}-01`)}
        />

        {onStatusFilterChange && (
          <PillToggle
            size="sm"
            value={statusFilter ?? 'all'}
            onChange={onStatusFilterChange}
            options={statusOptions}
            aria-label={t('budgets.statusFilterLabel', 'Filtrar por status')}
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        {actions}
        <Button
          type="button"
          size="sm"
          onClick={onNew}
          className="h-8 gap-1.5 text-xs font-semibold max-sm:min-h-11 max-sm:w-full"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t('budgets.new')}
        </Button>
      </div>
    </search>
  )
}
