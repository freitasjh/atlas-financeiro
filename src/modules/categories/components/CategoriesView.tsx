import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownRight, ArrowUpRight, FolderOpen, ListFilter, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/shadcn/ui/button'
import { Card, CardContent } from '@/components/shadcn/ui/card'
import { Skeleton } from '@/components/shadcn/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/ui/alert'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/shadcn/ui/empty'
import { cn } from '@/lib/cn'
import { useCategories } from '../hooks/useCategories'
import type { CategoryView } from '../model/category.adapter'
import { diffCategoryPatch, type CategoryFormValues } from '../model/category-diff'
import type { CategoryPatchInput } from '../model/category'
import { CategoriesToolbar } from './CategoriesToolbar'
import { CategoriesTable } from './CategoriesTable'
import { CategoryDialog } from './CategoryDialog'
import { CategoryDeleteDialog } from './CategoryDeleteDialog'
import { CategoryBlockedDialog } from './CategoryBlockedDialog'

// C2.1 — CategoriesView (Arquétipo 1 reduzido, sem gráfico):
// header (sem CTA) + KPIs + toolbar search + tabela + rodapé.
// Os 3 dialogs vivem na raiz. Hook-first: filtros/ordenação no useCategories.

export interface CategoriesViewProps {
  categories: CategoryView[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  onRetry: () => void
  onCreate: (values: CategoryFormValues) => Promise<void>
  onUpdate: (id: string, patch: CategoryPatchInput) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onRevalidateUsage: (id: string) => Promise<number>
}

type EditorState = { kind: 'create' } | { kind: 'edit'; row: CategoryView } | null

const DEBOUNCE_MS = 150

export function CategoriesView({
  categories,
  status,
  error,
  onRetry,
  onCreate,
  onUpdate,
  onRemove,
  onRevalidateUsage,
}: CategoriesViewProps) {
  const { t, i18n } = useTranslation()
  const { counts, filtered, isEmpty, isFilteredEmpty, search, setSearch, typeFilter, setTypeFilter } =
    useCategories(categories)

  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<EditorState>(null)
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CategoryView | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [blocked, setBlocked] = useState<{ row: CategoryView; count: number } | null>(null)
  // Guarda de reentrância: Enter duplo / duplo clique antes do re-render
  // não pode gerar duplo insert (C3.1 idempotência de submit).
  const submittingRef = useRef(false)

  // C2.2 — debounce ~150ms da busca (AND com as pílulas, que são imediatas).
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query, setSearch])

  const numberFormat = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language])
  const formatCount = (value: number): string => numberFormat.format(value)

  // KPI Sistema oculto até a flag existir no banco (C2.5): is_system ainda não
  // existe (Batch 1 defensivo) — nenhuma linha é read-only hoje. O card só
  // renderiza quando houver contagem real, sem mudar layout até lá.
  const showSystemKpi = counts.system > 0

  const openCreate = () => {
    setEditorError(null)
    setEditor({ kind: 'create' })
  }

  const openEdit = (row: CategoryView) => {
    if (row.isSystem) return
    setEditorError(null)
    setEditor({ kind: 'edit', row })
  }

  const handleEditorSubmit = async (values: CategoryFormValues) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setEditorSaving(true)
    setEditorError(null)
    try {
      if (editor?.kind === 'edit') {
        // Nit review Batch 1: early-return em update vazio (sem PUT à toa).
        const patch = diffCategoryPatch(editor.row, values)
        if (patch === null) {
          setEditor(null)
          return
        }
        await onUpdate(editor.row.id, patch)
      } else {
        await onCreate(values)
      }
      setEditor(null)
    } catch (e) {
      setEditorError(e instanceof Error ? e.message : t('categories.saveError'))
    } finally {
      submittingRef.current = false
      setEditorSaving(false)
    }
  }

  const handleRequestDelete = async (row: CategoryView) => {
    try {
      const count = await onRevalidateUsage(row.id)
      if (row.isSystem || count > 0) {
        setBlocked({ row, count })
        return
      }
      setDeleteError(null)
      setDeleteTarget(row)
    } catch {
      // Revalidação falhou: não apaga no escuro — abre o bloqueio honesto.
      setBlocked({ row, count: 0 })
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
      const message = e instanceof Error ? e.message : String(e)
      if (message.includes('category-in-use')) {
        // Corrida: alguém vinculou entre a revalidação e o delete — bloqueio honesto.
        const count = await onRevalidateUsage(deleteTarget.id).catch(() => 0)
        setDeleteTarget(null)
        setBlocked({ row: deleteTarget, count })
        toast.error(t('categories.inUseError'))
      } else {
        setDeleteError(
          message.includes('category-system-protected')
            ? t('categories.systemProtectedError')
            : t('categories.removeError'),
        )
      }
    } finally {
      setIsDeleting(false)
    }
  }

  const clearFilters = () => {
    setQuery('')
    setSearch('')
    setTypeFilter('all')
  }

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex w-full flex-col gap-5 px-4 pb-8 lg:px-6" aria-busy="true" aria-live="polite">
        <div className="flex flex-col gap-1">
          <Skeleton className="h-8 w-56 rounded-md" />
          <Skeleton className="h-4 w-80 max-w-full rounded-md" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
        <span className="sr-only">{t('categories.loading')}</span>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex w-full flex-col gap-5 px-4 pb-8 lg:px-6">
        <Alert variant="destructive">
          <AlertTitle>{t('common.error')}</AlertTitle>
          <AlertDescription role="alert">{error ?? t('categories.loadError')}</AlertDescription>
        </Alert>
        <Button type="button" variant="outline" onClick={onRetry} className="min-h-11 w-fit">
          {t('categories.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-5 px-4 pb-8 lg:px-6">
      {/* Header — sem CTA (Regra da Ação Única: o CTA vive na toolbar). */}
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {t('categories.title')}
        </h1>
        <p className="text-xs text-muted-foreground">{t('categories.subtitle')}</p>
      </div>

      {/* KPIs — sempre globais (ignoram filtros), interativos e com contexto %. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-live="polite">
        <Card
          data-testid="kpi-total"
          role="button"
          tabIndex={0}
          aria-pressed={typeFilter === 'all'}
          onClick={() => setTypeFilter('all')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setTypeFilter('all')
            }
          }}
          className={cn(
            "group relative cursor-pointer border-border/70 transition-all duration-150 hover:border-border hover:shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            typeFilter === 'all'
              ? "border-primary/50 bg-primary/[0.03] ring-1 ring-primary/40 shadow-xs"
              : "hover:bg-muted/30"
          )}
        >
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                {t('categories.kpiTotal')}
              </span>
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary transition-transform group-hover:scale-105">
                <FolderOpen className="size-4" aria-hidden="true" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between gap-2">
              <div className="font-mono text-2xl font-bold tracking-tight tabular-nums text-foreground">
                {formatCount(counts.total)}
              </div>
              <span className="text-[11px] font-medium text-muted-foreground/80">
                {counts.total > 0 ? "100%" : "—"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card
          data-testid="kpi-income"
          role="button"
          tabIndex={0}
          aria-pressed={typeFilter === 'income'}
          onClick={() => setTypeFilter(typeFilter === 'income' ? 'all' : 'income')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setTypeFilter(typeFilter === 'income' ? 'all' : 'income')
            }
          }}
          className={cn(
            "group relative cursor-pointer border-border/70 transition-all duration-150 hover:border-border hover:shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            typeFilter === 'income'
              ? "border-emerald-500/50 bg-emerald-500/[0.04] ring-1 ring-emerald-500/40 shadow-xs"
              : "hover:bg-muted/30"
          )}
        >
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                {t('categories.kpiIncome')}
              </span>
              <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 transition-transform group-hover:scale-105">
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between gap-2">
              <div className="font-mono text-2xl font-bold tracking-tight tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCount(counts.income)}
              </div>
              <span className="text-[11px] font-medium text-emerald-600/80 dark:text-emerald-400/80 font-mono tabular-nums">
                {counts.total > 0 ? `${Math.round((counts.income / counts.total) * 100)}%` : "0%"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card
          data-testid="kpi-expense"
          role="button"
          tabIndex={0}
          aria-pressed={typeFilter === 'expense'}
          onClick={() => setTypeFilter(typeFilter === 'expense' ? 'all' : 'expense')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setTypeFilter(typeFilter === 'expense' ? 'all' : 'expense')
            }
          }}
          className={cn(
            "group relative cursor-pointer border-border/70 transition-all duration-150 hover:border-border hover:shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            typeFilter === 'expense'
              ? "border-rose-500/50 bg-rose-500/[0.04] ring-1 ring-rose-500/40 shadow-xs"
              : "hover:bg-muted/30"
          )}
        >
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                {t('categories.kpiExpense')}
              </span>
              <div className="flex size-8 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400 transition-transform group-hover:scale-105">
                <ArrowDownRight className="size-4" aria-hidden="true" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between gap-2">
              <div className="font-mono text-2xl font-bold tracking-tight tabular-nums text-rose-600 dark:text-rose-400">
                {formatCount(counts.expense)}
              </div>
              <span className="text-[11px] font-medium text-rose-600/80 dark:text-rose-400/80 font-mono tabular-nums">
                {counts.total > 0 ? `${Math.round((counts.expense / counts.total) * 100)}%` : "0%"}
              </span>
            </div>
          </CardContent>
        </Card>

        {showSystemKpi ? (
          <Card className="border-border/70 shadow-xs" data-testid="kpi-system">
            <CardContent className="p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{t('categories.kpiSystem')}</span>
              </div>
              <div className="mt-3 flex items-baseline justify-between gap-2">
                <div className="font-mono text-2xl font-bold tracking-tight tabular-nums text-foreground">
                  {formatCount(counts.system)}
                </div>
                <span className="text-[11px] font-medium text-muted-foreground font-mono tabular-nums">
                  {counts.total > 0 ? `${Math.round((counts.system / counts.total) * 100)}%` : "0%"}
                </span>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {isEmpty ? (
        <Empty data-testid="categories-empty-global">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t('categories.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('categories.emptyHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={openCreate} className="h-11 min-h-11 gap-1.5">
              <Plus className="size-4" aria-hidden="true" />
              {t('categories.new')}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <CategoriesToolbar
            query={query}
            onQueryChange={setQuery}
            typeFilter={typeFilter}
            onTypeFilterChange={setTypeFilter}
            onNew={openCreate}
          />

          {isFilteredEmpty ? (
            <Empty data-testid="categories-empty-filtered">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ListFilter aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{t('categories.noResults', { query: search })}</EmptyTitle>
                <EmptyDescription>{t('categories.noResultsHint')}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" variant="outline" onClick={clearFilters} className="h-11 min-h-11">
                  {t('categories.clearFilters')}
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <CategoriesTable
              rows={filtered}
              totalCount={categories.length}
              onEdit={openEdit}
              onRequestDelete={handleRequestDelete}
            />
          )}
        </>
      )}

      {/* Dialogs na raiz — Esc fecha, foco retorna ao trigger (Radix). */}
      <CategoryDialog
        open={editor !== null}
        mode={editor?.kind === 'edit' ? 'edit' : 'create'}
        initial={editor?.kind === 'edit' ? editor.row : undefined}
        isSaving={editorSaving}
        serverError={editorError}
        onOpenChange={(open) => {
          if (!open) setEditor(null)
        }}
        onSubmit={handleEditorSubmit}
      />
      <CategoryDeleteDialog
        open={deleteTarget !== null}
        categoryName={deleteTarget?.name ?? ''}
        isDeleting={isDeleting}
        error={deleteError}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        onConfirm={handleConfirmDelete}
      />
      <CategoryBlockedDialog
        open={blocked !== null}
        categoryId={blocked?.row.id ?? ''}
        categoryName={blocked?.row.name ?? ''}
        usageCount={blocked?.count ?? 0}
        isSystem={blocked?.row.isSystem ?? false}
        onOpenChange={(open) => {
          if (!open) setBlocked(null)
        }}
      />
    </div>
  )
}
