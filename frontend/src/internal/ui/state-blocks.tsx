/**
 * Blocos de estado obrigatórios de cada tela de dados (REQ-36/UX §5):
 * carregando, vazio, erro rotulado sem PII e paginação honesta.
 */

import { AlertTriangle, Inbox, RotateCw } from "lucide-react"

import { Button } from "@/components/shadcn/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/shadcn/ui/empty"
import { Skeleton } from "@/components/shadcn/ui/skeleton"
import { useInternalT } from "./use-internal-t"

/** Teto de página do painel: nenhuma requisição pede mais que 100 (REQ-37). */
export const INTERNAL_PAGE_SIZE = 20
export const INTERNAL_MAX_PAGE_SIZE = 100

const SKELETON_KEYS = [0, 1, 2, 3, 4, 5]

export function InternalLoadingState({ rows = 3 }: { rows?: number }) {
  const t = useInternalT()
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2 p-4">
      <span className="sr-only">{t("internalAdmin.states.loading")}</span>
      {SKELETON_KEYS.slice(0, rows).map((key) => (
        <Skeleton key={key} className="h-9 w-full" />
      ))}
    </div>
  )
}

export function InternalEmptyState({
  title,
  description,
}: {
  title?: string
  description?: string
}) {
  const t = useInternalT()
  return (
    <Empty className="border border-dashed border-border/70">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{title ?? t("internalAdmin.states.emptyTitle")}</EmptyTitle>
        <EmptyDescription>
          {description ?? t("internalAdmin.states.emptyHint")}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** Erro de leitura: rótulo fixo, sem id/PII, retry explícito. */
export function InternalErrorState({ onRetry }: { onRetry: () => void }) {
  const t = useInternalT()
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
        <AlertTriangle className="size-4" aria-hidden="true" />
        {t("internalAdmin.states.errorTitle")}
      </div>
      <p className="text-xs text-muted-foreground">{t("internalAdmin.states.errorBody")}</p>
      <Button type="button" variant="outline" className="min-h-11" onClick={onRetry}>
        <RotateCw className="size-4" aria-hidden="true" />
        {t("internalAdmin.states.retry")}
      </Button>
    </div>
  )
}

export interface InternalPagerProps {
  total: number
  limit: number
  offset: number
  onChange: (nextOffset: number) => void
}

/** "Mostrando X–Y de N" — contadores com `tabular-nums`. */
export function InternalPager({ total, limit, offset, onChange }: InternalPagerProps) {
  const t = useInternalT()
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0
  const from = safeTotal === 0 ? 0 : offset + 1
  const to = Math.min(offset + limit, safeTotal)
  const hasPrevious = offset > 0
  const hasNext = to < safeTotal

  return (
    <div className="flex flex-col gap-2 border-t border-border/70 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span className="tabular-nums">
        {t("internalAdmin.pager.showing", { from, to, total: safeTotal })}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={!hasPrevious}
          onClick={() => onChange(Math.max(offset - limit, 0))}
        >
          {t("internalAdmin.pager.previous")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={!hasNext}
          onClick={() => onChange(offset + limit)}
        >
          {t("internalAdmin.pager.next")}
        </Button>
      </div>
    </div>
  )
}

/**
 * Navegação sem total: `list_admin_audit_page` não devolve contagem, então a
 * trilha nunca afirma "de N" — só a página corrente e os botões (REQ-36).
 */
export function InternalPageNav({
  limit,
  offset,
  count,
  onChange,
}: {
  limit: number
  offset: number
  count: number
  onChange: (nextOffset: number) => void
}) {
  const t = useInternalT()
  const page = Math.floor(offset / limit) + 1
  return (
    <div className="flex flex-col gap-2 border-t border-border/70 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span className="tabular-nums">{t("internalAdmin.pager.page", { page })}</span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(offset - limit, 0))}
        >
          {t("internalAdmin.pager.previous")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={count < limit}
          onClick={() => onChange(offset + limit)}
        >
          {t("internalAdmin.pager.next")}
        </Button>
      </div>
    </div>
  )
}
