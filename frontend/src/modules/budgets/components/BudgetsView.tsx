import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, PiggyBank, SearchX, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/shadcn/ui/button'
import { Card, CardContent } from '@/components/shadcn/ui/card'
import { Skeleton } from '@/components/shadcn/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/ui/alert'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/shadcn/ui/empty'
import { formatCentsBRL, cn } from '@/lib/utils'
import { useBudgets } from '../hooks/useBudgets'
import type { BudgetView } from '../model/budget.adapter'
import type { BudgetInput, BudgetPatchInput } from '../model/budget'
import { BudgetsToolbar } from './BudgetsToolbar'
import { BudgetsTable } from './BudgetsTable'
import { BudgetDialog, type BudgetCategoryOption, type BudgetDialogInitial } from './BudgetDialog'
import { BudgetDeleteDialog } from './BudgetDeleteDialog'

// O2.1/O2.4 — BudgetsView (Arquétipo 1): header (sem CTA) + KPIs +
// toolbar search/mês + tabela + rodapé. Dialogs na raiz; hook-first.

export interface BudgetsViewProps {
  budgets: BudgetView[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  month: string
  onMonthChange: (month: string) => void
  categories: BudgetCategoryOption[]
  onRetry: () => void
  onCreate: (values: BudgetInput) => Promise<void>
  onUpdate: (id: string, patch: BudgetPatchInput) => Promise<void>
  onRemove: (id: string) => Promise<void>
}

type EditorState = { kind: 'create' } | { kind: 'edit'; row: BudgetView } | null

const DEBOUNCE_MS = 150

export function BudgetsView({
  budgets,
  status,
  error,
  month,
  onMonthChange,
  categories,
  onRetry,
  onCreate,
  onUpdate,
  onRemove,
}: BudgetsViewProps) {
  const { t, i18n } = useTranslation()
  const { kpis, filtered, isEmpty, isFilteredEmpty, search, setSearch, statusFilter, setStatusFilter } =
    useBudgets(budgets)

  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<EditorState>(null)
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BudgetView | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  // Guarda de reentrância: Enter duplo antes do re-render não gera duplo insert.
  const submittingRef = useRef(false)

  // Debounce ~150ms da busca.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query, setSearch])

  const money = useMemo(() => {
    const fmt = (cents: number): string => formatCentsBRL(cents, i18n.language)
    const percent = kpis.percentBps === 0 ? '0%' : `${(kpis.percentBps / 100).toLocaleString(i18n.language)}%`
    const remainingCents = kpis.totalLimitCents - kpis.totalSpentCents
    return {
      total: fmt(kpis.totalLimitCents),
      spent: fmt(kpis.totalSpentCents),
      percent,
      remaining: fmt(Math.abs(remainingCents)),
      remainingCents,
    }
  }, [kpis, i18n.language])

  const openCreate = () => {
    setEditorError(null)
    setEditor({ kind: 'create' })
  }

  const openEdit = (row: BudgetView) => {
    setEditorError(null)
    setEditor({ kind: 'edit', row })
  }

  const handleEditorSubmit = async (values: BudgetInput) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setEditorSaving(true)
    setEditorError(null)
    try {
      if (editor?.kind === 'edit') {
        await onUpdate(editor.row.id, { month: values.month, limit_cents: values.limit_cents })
      } else {
        await onCreate(values)
      }
      setEditor(null)
    } catch (e) {
      setEditorError(e instanceof Error ? e.message : t('budgets.saveError'))
    } finally {
      submittingRef.current = false
      setEditorSaving(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    setDeleteError(null)
    try {
      await onRemove(deleteTarget.id)
      setDeleteTarget(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('budgets.saveError'))
      toast.error(e instanceof Error ? e.message : t('budgets.saveError'))
    } finally {
      setIsDeleting(false)
    }
  }

  const clearFilters = () => {
    setQuery('')
    setSearch('')
  }

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex w-full flex-col gap-5 px-4 pb-8 lg:px-6" aria-busy="true" aria-live="polite">
        <div className="flex flex-col gap-1">
          <Skeleton className="h-8 w-56 rounded-md" />
          <Skeleton className="h-4 w-80 max-w-full rounded-md" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
        <span className="sr-only">{t('budgets.loading')}</span>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex w-full flex-col gap-5 px-4 pb-8 lg:px-6">
        <Alert variant="destructive">
          <AlertTitle>{t('common.error')}</AlertTitle>
          <AlertDescription role="alert">{error ?? t('budgets.loadError')}</AlertDescription>
        </Alert>
        <Button type="button" variant="outline" onClick={onRetry} className="min-h-11 w-fit">
          {t('budgets.retry')}
        </Button>
      </div>
    )
  }

  const editorInitial: BudgetDialogInitial | undefined =
    editor?.kind === 'edit'
      ? { categoryId: editor.row.categoryId, month: editor.row.month, limitCents: editor.row.limitCents }
      : undefined

  return (
    <div className="flex w-full flex-col gap-5 px-4 pb-8 lg:px-6">
      {/* Header — sem CTA (Regra da Ação Única: o CTA vive na toolbar). */}
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {t('budgets.title')}
        </h1>
        <p className="text-xs text-muted-foreground">{t('budgets.subtitle')}</p>
      </div>

      {/* KPIs — sempre globais (ignoram filtros), interativos e com contexto %. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-live="polite">
        <Card
          data-testid="kpi-total"
          role="button"
          tabIndex={0}
          aria-pressed={statusFilter === 'all'}
          onClick={() => setStatusFilter('all')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setStatusFilter('all')
            }
          }}
          className={cn(
            "group relative cursor-pointer border-border/70 transition-all duration-150 hover:border-border hover:shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            statusFilter === 'all'
              ? "border-primary/50 bg-primary/[0.03] ring-1 ring-primary/40 shadow-xs"
              : "hover:bg-muted/30"
          )}
        >
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                {t('budgets.kpiTotal')}
              </span>
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary transition-transform group-hover:scale-105">
                <PiggyBank className="size-4" aria-hidden="true" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between gap-2">
              <div className="font-mono text-2xl font-bold tracking-tight tabular-nums text-foreground">
                {money.total}
              </div>
              <span className="text-[11px] font-medium text-muted-foreground/80">
                {kpis.count} {t('budgets.categoriesCount', 'tetos')}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card
          data-testid="kpi-spent"
          className="border-border/70 shadow-xs hover:border-border hover:shadow-xs transition-all duration-150"
        >
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                {t('budgets.kpiSpent')}
              </span>
              <div className="flex size-8 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400">
                <Wallet className="size-4" aria-hidden="true" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between gap-2">
              <div className="font-mono text-2xl font-bold tracking-tight tabular-nums text-foreground">
                {money.spent}
              </div>
              <span
                className={cn(
                  "text-[11px] font-medium font-mono tabular-nums",
                  money.remainingCents >= 0
                    ? "text-emerald-600/80 dark:text-emerald-400/80"
                    : "text-rose-600/80 dark:text-rose-400/80"
                )}
              >
                {money.remainingCents >= 0 ? "+ " : "- "}
                {money.remaining}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card
          data-testid="kpi-used"
          className="border-border/70 shadow-xs hover:border-border hover:shadow-xs transition-all duration-150"
        >
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">{t('budgets.kpiUsed')}</span>
              <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <span className="text-xs font-bold font-mono">{kpis.overCount > 0 ? "⚠️" : "✓"}</span>
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between gap-2">
              <div className="font-mono text-2xl font-bold tracking-tight tabular-nums text-foreground">
                {money.percent}
              </div>
              <span className="text-[11px] font-medium text-muted-foreground font-mono tabular-nums">
                {kpis.percentBps >= 10000
                  ? t('budgets.rateOver', 'Acima do teto')
                  : kpis.percentBps >= 8000
                  ? t('budgets.rateWarn', 'Perto do teto')
                  : t('budgets.rateOk', 'Sob controle')}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card
          data-testid="kpi-over"
          role="button"
          tabIndex={0}
          aria-pressed={statusFilter === 'over'}
          onClick={() => setStatusFilter(statusFilter === 'over' ? 'all' : 'over')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setStatusFilter(statusFilter === 'over' ? 'all' : 'over')
            }
          }}
          className={cn(
            "group relative cursor-pointer border-border/70 transition-all duration-150 hover:border-border hover:shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            statusFilter === 'over'
              ? "border-amber-500/50 bg-amber-500/[0.04] ring-1 ring-amber-500/40 shadow-xs"
              : "hover:bg-muted/30"
          )}
        >
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                {t('budgets.kpiOver')}
              </span>
              <div className="flex size-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 transition-transform group-hover:scale-105">
                <CircleAlert className="size-4" aria-hidden="true" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between gap-2">
              <div className="font-mono text-2xl font-bold tracking-tight tabular-nums text-foreground">
                {kpis.overCount.toLocaleString(i18n.language)}
              </div>
              <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400 font-mono tabular-nums">
                {kpis.overCount > 0 ? t('budgets.needsAttention', 'atenção') : t('budgets.allGood', 'em dia')}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Toolbar sempre visível — inclusive com 0 tetos (B1.1). */}
      <BudgetsToolbar
        query={query}
        onQueryChange={setQuery}
        month={month}
        onMonthChange={onMonthChange}
        onNew={openCreate}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
      />

      {isEmpty ? (
        <Empty data-testid="budgets-empty-global">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PiggyBank aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t('budgets.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('budgets.emptyHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" variant="outline" onClick={openCreate} className="h-11 min-h-11 gap-1.5">
              {t('budgets.new')}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          {isFilteredEmpty ? (
            <Empty data-testid="budgets-empty-filtered">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchX aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{t('budgets.noResults', { query: search })}</EmptyTitle>
                <EmptyDescription>{t('budgets.noResultsHint')}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" variant="outline" onClick={clearFilters} className="h-11 min-h-11">
                  {t('budgets.clearFilters')}
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <BudgetsTable
              rows={filtered}
              totalCount={budgets.length}
              onEdit={openEdit}
              onRequestDelete={(row) => {
                setDeleteError(null)
                setDeleteTarget(row)
              }}
            />
          )}
        </>
      )}

      {/* Dialogs na raiz — Esc fecha, foco retorna ao trigger (Radix). */}
      <BudgetDialog
        open={editor !== null}
        mode={editor?.kind === 'edit' ? 'edit' : 'create'}
        initial={editorInitial}
        categories={categories}
        isSaving={editorSaving}
        serverError={editorError}
        onOpenChange={(open) => {
          if (!open) setEditor(null)
        }}
        onSubmit={handleEditorSubmit}
      />
      <BudgetDeleteDialog
        open={deleteTarget !== null}
        categoryName={deleteTarget?.categoryName ?? ''}
        isDeleting={isDeleting}
        error={deleteError}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        onConfirm={handleConfirmDelete}
      />
    </div>
  )
}
