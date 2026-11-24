// O2.1/O2.2/O2.4 — tabela de staging/revisão (pré-insert, sem persistência).
// Reaproveita padrões da StatementTable + toolbar <search> (Regra Ação Única).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, CheckCircle2, Loader2 } from 'lucide-react'
import { Input } from '@/components/shadcn/ui/input'
import { Button } from '@/components/shadcn/ui/button'
import { Badge } from '@/components/shadcn/ui/badge'
import { Checkbox } from '@/components/shadcn/ui/checkbox'
import { formatCentsBRL } from '@/lib/utils'
import type { StagedRow, StagingCounts } from '../hooks/useImportStaging'

export interface StagingCategory {
  id: string
  name: string
}

interface ImportStagingTableProps {
  rows: StagedRow[]
  counts: StagingCounts
  confirmCount: number
  allNewSelected: boolean
  categories: StagingCategory[]
  onToggleRow: (id: string) => void
  onToggleAll: (checked: boolean) => void
  onCategoryChange: (id: string, categoryId: string | null) => void
  onConfirm: () => void
  isConfirming?: boolean
}

export function ImportStagingTable({
  rows,
  counts,
  confirmCount,
  allNewSelected,
  categories,
  onToggleRow,
  onToggleAll,
  onCategoryChange,
  onConfirm,
  isConfirming = false,
}: ImportStagingTableProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')

  const term = search.trim().toLowerCase()
  const filtered = term
    ? rows.filter((row) => row.description.toLowerCase().includes(term))
    : rows

  return (
    <div className="rounded-2xl border border-border/80 bg-card text-card-foreground shadow-xs overflow-hidden min-w-0 w-full">
      <div className="p-4 border-b border-border/70 bg-muted/20">
        <p className="text-xs font-semibold text-foreground tabular-nums" role="status" aria-live="polite">
          {t('accounts.staging.counts', { new: counts.new, dup: counts.dup, invalid: counts.invalid })}
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{t('accounts.staging.subtitle')}</p>
      </div>

      <search
        aria-label={t('accounts.staging.searchLabel')}
        className="p-4 border-b border-border/60 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between"
      >
        <div className="relative w-full sm:w-72">
          <Search className="absolute inset-y-0 left-3 my-auto h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder={t('accounts.staging.searchPlaceholder')}
            aria-label={t('accounts.staging.searchLabel')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 text-xs bg-background border-border/80 w-full"
          />
        </div>
        <Button
          type="button"
          size="sm"
          disabled={confirmCount === 0 || isConfirming}
          aria-busy={isConfirming}
          onClick={onConfirm}
          className="h-9 min-h-11 text-xs font-bold gap-1.5"
        >
          {isConfirming ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          <span>{t('accounts.staging.confirm', { count: confirmCount })}</span>
        </Button>
      </search>

      <div data-testid="staging-table-scroll" className="max-h-[320px] overflow-y-auto overflow-x-auto overscroll-contain min-w-0">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 z-10 border-b border-border/70 bg-muted/30 text-muted-foreground font-semibold">
            <tr>
              <th className="py-3 px-4 w-10">
                <Checkbox
                  checked={allNewSelected}
                  onCheckedChange={(checked) => onToggleAll(checked === true)}
                  aria-label={t('accounts.staging.selectAll')}
                  className="size-5"
                />
              </th>
              <th className="py-3 px-4">{t('accounts.staging.colDate')}</th>
              <th className="py-3 px-4">{t('accounts.staging.colDescription')}</th>
              <th className="py-3 px-4 text-right">{t('accounts.staging.colAmount')}</th>
              <th className="py-3 px-4">{t('accounts.staging.colType')}</th>
              <th className="py-3 px-4">{t('accounts.staging.colCategory')}</th>
              <th className="py-3 px-4">{t('accounts.staging.colStatus')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-muted-foreground">
                  {t('accounts.staging.empty')}
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr key={row.id} className="hover:bg-muted/30 transition-colors">
                  <td className="py-3 px-4">
                    {!row.dup ? (
                      <Checkbox
                        checked={row.selected}
                        onCheckedChange={() => onToggleRow(row.id)}
                        aria-label={t('accounts.staging.selectRow', { description: row.description })}
                        className="size-5"
                      />
                    ) : null}
                  </td>
                  <td className="py-3 px-4 font-mono tabular-nums text-muted-foreground whitespace-nowrap">{row.date}</td>
                  <td className="py-3 px-4 min-w-[180px]">
                    <p className="font-medium text-foreground truncate">{row.description}</p>
                  </td>
                  <td className="py-3 px-4 font-mono font-bold text-right tabular-nums whitespace-nowrap">
                    <span className={row.type === 'income' ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}>
                      {row.type === 'income' ? `+ ${formatCentsBRL(row.amount_cents)}` : `- ${formatCentsBRL(row.amount_cents)}`}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-muted-foreground">
                    {row.type === 'income' ? t('accounts.staging.typeIncome') : t('accounts.staging.typeExpense')}
                  </td>
                  <td className="py-3 px-4 min-w-[160px]">
                    {row.dup ? (
                      <span className="text-[11px] text-muted-foreground">—</span>
                    ) : (
                      <select
                        aria-label={t('accounts.staging.categoryLabel', { description: row.description })}
                        value={row.category_id ?? ''}
                        onChange={(e) => onCategoryChange(row.id, e.target.value === '' ? null : e.target.value)}
                        className="flex w-full h-10 min-h-11 rounded-md border border-border/80 bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <option value="">{t('accounts.staging.noCategory')}</option>
                        {categories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="py-3 px-4 whitespace-nowrap">
                    {row.dup ? (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-semibold"
                      >
                        {t('accounts.staging.badgeDuplicate')}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px] font-semibold">
                        {t('accounts.staging.badgeNew')}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
