import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Download,
  Paperclip,
  Check,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/ui/alert'
import { Input } from '@/components/shadcn/ui/input'
import { Button } from '@/components/shadcn/ui/button'
import { Badge } from '@/components/shadcn/ui/badge'
import { Label } from '@/components/shadcn/ui/label'
import { Skeleton } from '@/components/shadcn/ui/skeleton'
import { PillToggle } from '@/components/shadcn/ui/pill-toggle'
import { formatCentsBRL } from '@/lib/utils'
import { formatStatementDate } from '../model/view-model'
import type {
  AccountViewItem,
  ReconciliationStatus,
  StatementTxType,
  StatementTxView,
} from '../model/view-model'

interface StatementTableProps {
  account: AccountViewItem | null
  transactions: StatementTxView[]
  /** Lançamentos em carregamento (B-A12) — skeleton em vez de vazio falso. */
  isLoading?: boolean
  /** Falha real na carga dos lançamentos (B-A12) — alert com retry. */
  hasError?: boolean
  /** Total real no store; se maior que o carregado, o rodapé declara o teto (D2). */
  totalCount?: number
  onRetryTransactions?: () => void
  onReconcileTransaction?: (txId: string) => void
  onExportStatement?: (format: 'csv' | 'pdf' | 'ofx') => void
}

type TypeFilter = 'all' | 'in' | 'out'
type StatusFilter = 'all' | ReconciliationStatus

/** Paginação client-side (B-A9): 25 linhas por página. */
const PAGE_SIZE = 25

export function StatementTable({
  account,
  transactions,
  isLoading = false,
  hasError = false,
  totalCount,
  onRetryTransactions,
  onReconcileTransaction,
  onExportStatement,
}: StatementTableProps) {
  const { t } = useTranslation()
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [page, setPage] = useState(1)

  const filtered = transactions.filter((tx) => {
    if (account && tx.accountId !== account.id) return false
    if (statusFilter !== 'all' && tx.reconciliationStatus !== statusFilter) return false
    if (typeFilter === 'in' && tx.type !== 'credit' && tx.type !== 'transfer_in') return false
    if (typeFilter === 'out' && tx.type !== 'debit' && tx.type !== 'transfer_out') return false

    const term = searchTerm.toLowerCase().trim()
    if (!term) return true
    return (
      tx.description.toLowerCase().includes(term) ||
      tx.category.toLowerCase().includes(term) ||
      (tx.counterparty && tx.counterparty.toLowerCase().includes(term)) ||
      (tx.documentNumber && tx.documentNumber.toLowerCase().includes(term))
    )
  })

  // Filtro/conta mudou ⇒ volta para a primeira página (B-A9).
  useEffect(() => {
    setPage(1)
  }, [searchTerm, statusFilter, typeFilter, account?.id])

  const isFiltered = searchTerm.trim() !== '' || statusFilter !== 'all' || typeFilter !== 'all'
  const total = filtered.length
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pageStart = (currentPage - 1) * PAGE_SIZE
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE)
  const hasData = transactions.length > 0
  const loadedCount = transactions.length
  const capExceeded = typeof totalCount === 'number' && totalCount > loadedCount
  const showPagination = !isLoading && !hasError && total > 0
  const emptyExportHint = t('accounts.exportEmptyHint')

  const reconciliationBadge = (status: ReconciliationStatus) => {
    switch (status) {
      case 'reconciled':
        return (
          <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-semibold gap-1">
            <CheckCircle2 className="h-3 w-3" />
            {t('accounts.statement.badgeReconciled')}
          </Badge>
        )
      case 'pending':
        return (
          <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-semibold gap-1">
            <Clock className="h-3 w-3" />
            {t('accounts.statement.badgePending')}
          </Badge>
        )
      case 'divergent':
        return (
          <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive text-[10px] font-semibold gap-1">
            <AlertTriangle className="h-3 w-3" />
            {t('accounts.statement.badgeDivergent')}
          </Badge>
        )
    }
  }

  const transactionIcon = (type: StatementTxType) => {
    switch (type) {
      case 'credit':
        return (
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 shrink-0">
            <ArrowDownLeft className="h-4 w-4" />
          </div>
        )
      case 'debit':
        return (
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-muted-foreground shrink-0">
            <ArrowUpRight className="h-4 w-4" />
          </div>
        )
      case 'transfer_in':
      case 'transfer_out':
        return (
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
            <ArrowLeftRight className="h-4 w-4" />
          </div>
        )
    }
  }

  return (
    <div
      aria-busy={isLoading ? true : undefined}
      className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-border/80 bg-card text-card-foreground shadow-xs"
    >
      <div className="p-4 sm:p-5 border-b border-border/70 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-muted/20">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-foreground">
            {account ? t('accounts.statement.titleOne', { name: account.nickname }) : t('accounts.statement.titleAll')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('accounts.statement.subtitle')}</p>
        </div>

        <div className="flex items-center gap-1.5 self-start sm:self-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasData || isLoading || hasError}
            title={!hasData ? emptyExportHint : undefined}
            aria-disabled={!hasData || isLoading || hasError}
            onClick={() => onExportStatement?.('csv')}
            className="min-h-11 px-3 text-xs font-semibold gap-1 sm:h-8 sm:min-h-8"
          >
            <Download className="h-3 w-3" />
            <span>CSV</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasData || isLoading || hasError}
            title={!hasData ? emptyExportHint : undefined}
            aria-disabled={!hasData || isLoading || hasError}
            onClick={() => onExportStatement?.('ofx')}
            className="min-h-11 px-3 text-xs font-semibold gap-1 sm:h-8 sm:min-h-8"
          >
            <Download className="h-3 w-3" />
            <span>OFX</span>
          </Button>
        </div>
      </div>

      <search
        aria-label={t('accounts.statement.searchAria')}
        className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center lg:justify-between"
      >
        <div className="relative w-full lg:max-w-xs">
          <Label htmlFor="statement-search-rota" className="sr-only">
            {t('accounts.statement.searchAria')}
          </Label>
          <Search className="pointer-events-none absolute inset-y-0 left-3 my-auto size-4 text-muted-foreground" />
          <Input
            id="statement-search-rota"
            type="search"
            placeholder={t('accounts.statementSearch')}
            aria-label={t('accounts.statement.searchAria')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-10 bg-background pl-9 text-base border-border/80 sm:h-9 sm:text-sm"
          />
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 pb-1 lg:w-auto lg:flex-nowrap lg:pb-0">
          <PillToggle
            size="sm"
            value={typeFilter}
            onChange={(value) => setTypeFilter(value as TypeFilter)}
            aria-label={t('accounts.statement.typeFilterAria')}
            options={[
              { value: 'all', label: t('accounts.statement.all') },
              { value: 'in', label: t('accounts.statement.inflow') },
              { value: 'out', label: t('accounts.statement.outflow') },
            ]}
          />

          <PillToggle
            size="sm"
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as StatusFilter)}
            aria-label={t('accounts.statement.statusFilterAria')}
            options={[
              { value: 'all', label: t('accounts.statement.statusAll') },
              { value: 'reconciled', label: t('accounts.statement.reconciled') },
              { value: 'pending', label: t('accounts.statement.pending') },
            ]}
          />
        </div>
      </search>

      {isLoading ? (
        <div data-testid="statement-skeleton" className="flex flex-col gap-3 p-4">
          <p className="text-xs text-muted-foreground">{t('accounts.statement.loading')}</p>
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-full rounded-md" />
          ))}
        </div>
      ) : hasError ? (
        <div className="p-4">
          <Alert variant="destructive">
            <AlertTitle>{t('common.error')}</AlertTitle>
            <AlertDescription>{t('accounts.statement.loadError')}</AlertDescription>
          </Alert>
          <Button
            type="button"
            variant="outline"
            onClick={() => onRetryTransactions?.()}
            className="mt-3 min-h-11 text-xs font-semibold"
          >
            {t('accounts.statement.retry')}
          </Button>
        </div>
      ) : (
      <div className="w-full max-w-full overflow-x-auto">
        <table className="w-full min-w-[680px] table-fixed text-left text-xs">
          <thead className="border-b border-border/70 bg-muted/30 text-muted-foreground font-semibold">
            <tr>
              <th className="w-[104px] py-3 px-4">{t('accounts.statement.colDate')}</th>
              <th className="w-[36%] max-w-[380px] py-3 px-4">{t('accounts.statement.colDescription')}</th>
              <th className="w-[15%] py-3 px-4 hidden md:table-cell">{t('accounts.statement.colCounterparty')}</th>
              <th className="w-[12%] py-3 px-4 hidden sm:table-cell">{t('accounts.statement.colDocument')}</th>
              <th className="w-[132px] py-3 px-4 text-right">{t('accounts.statement.colAmount')}</th>
              <th className="w-[112px] py-3 px-4 text-center">{t('accounts.statement.colStatus')}</th>
              <th className="w-[104px] py-3 px-4 text-right">{t('accounts.statement.colAction')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {total === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-muted-foreground">
                  {isFiltered && hasData
                    ? t('accounts.statement.emptyFiltered')
                    : t('accounts.statement.empty')}
                </td>
              </tr>
            ) : (
              pageRows.map((tx) => {
                const isCredit = tx.type === 'credit' || tx.type === 'transfer_in'
                const magnitudeCents = Math.abs(tx.amountCents)
                return (
                  <tr key={tx.id} className="hover:bg-muted/30 transition-colors">
                    <td className="py-3 px-4 font-mono tabular-nums text-muted-foreground whitespace-nowrap">{formatStatementDate(tx.date)}</td>
                    <td className="w-[36%] max-w-[380px] py-3 px-4">
                      <div className="flex min-w-0 max-w-full items-center gap-2.5">
                        {transactionIcon(tx.type)}
                        <div className="min-w-0 max-w-full">
                          <p className="font-bold text-foreground truncate">{tx.description}</p>
                          <span className="text-[10px] text-muted-foreground block truncate">{tx.category}</span>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 hidden md:table-cell text-muted-foreground truncate">
                      {tx.counterparty || '---'}
                    </td>
                    <td className="py-3 px-4 hidden sm:table-cell font-mono tabular-nums text-[11px] text-muted-foreground">
                      <div className="flex min-w-0 items-center gap-1">
                        {tx.hasAttachment && (
                          <span title={t('accounts.statement.attachmentTitle')}>
                            <Paperclip className="h-3 w-3 text-primary shrink-0" />
                          </span>
                        )}
                        <span className="truncate">{tx.documentNumber || '---'}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono font-extrabold text-right tabular-nums whitespace-nowrap">
                      <span className={isCredit ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}>
                        {isCredit ? `+ ${formatCentsBRL(magnitudeCents)}` : `- ${formatCentsBRL(magnitudeCents)}`}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center whitespace-nowrap">{reconciliationBadge(tx.reconciliationStatus)}</td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      {tx.reconciliationStatus === 'pending' ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onReconcileTransaction?.(tx.id)}
                          className="min-h-11 min-w-11 px-2 text-[11px] font-semibold gap-1 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10 border-emerald-500/30 sm:h-8 sm:min-h-8 sm:min-w-8"
                        >
                          <Check className="h-3 w-3" />
                          <span>{t('accounts.statement.reconcile')}</span>
                        </Button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground font-mono">{t('accounts.statement.ok')}</span>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      )}

      {showPagination && (
        <div className="flex flex-col gap-2 border-t border-border/70 px-4 py-2.5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span data-testid="statement-page-summary" className="tabular-nums">
            {t('accounts.statement.showing', {
              from: total === 0 ? 0 : pageStart + 1,
              to: Math.min(pageStart + PAGE_SIZE, total),
              total,
            })}
            {capExceeded
              ? ` · ${t('accounts.statement.showingCap', { loaded: loadedCount, total: totalCount })}`
              : null}
          </span>
          <div className="flex items-center gap-2">
            <span data-testid="statement-page-indicator" className="tabular-nums">
              {t('accounts.statement.pageOf', { page: currentPage, pages: pageCount })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={t('accounts.statement.prevPage')}
              title={t('accounts.statement.prevPage')}
              disabled={currentPage <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              className="min-h-11 min-w-11 px-2 sm:h-8 sm:min-h-8 sm:min-w-8"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={t('accounts.statement.nextPage')}
              title={t('accounts.statement.nextPage')}
              disabled={currentPage >= pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              className="min-h-11 min-w-11 px-2 sm:h-8 sm:min-h-8 sm:min-w-8"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
