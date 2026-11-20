/**
 * `/internal` — KPIs de `admin_mrr_summary` (REQ-32, UX §21).
 *
 * Quatro cartões, cada um rastreando uma chave da RPC. Nenhum percentual, delta
 * ou projeção: a RPC não devolve série histórica de MRR (REQ-32).
 */

import { AlertTriangle, Building2, CircleDollarSign, Users } from "lucide-react"

import { Card, CardContent } from "@/components/shadcn/ui/card"
import { useInternalRead } from "@/internal/ui/use-internal-read"
import type { MrrSummary, UsageSeriesRow } from "@/internal/data/internal-types"
import { formatCount, formatCurrency, formatDate } from "@/internal/ui/format"
import { InternalPageHeader } from "@/internal/ui/page-header"
import { InternalErrorState, InternalLoadingState } from "@/internal/ui/state-blocks"
import { useInternalT } from "../ui/use-internal-t"

function KpiCard({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string
  value: string
  hint: string
  tone: "revenue" | "neutral" | "attention" | "expense"
  icon: React.ReactNode
}) {
  const toneClass = {
    revenue: "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
    neutral: "bg-primary/10 text-primary",
    attention: "bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
    expense: "bg-rose-500/10 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400",
  }[tone]

  return (
    <Card className="border-border/70 shadow-xs">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <span className={`flex size-8 items-center justify-center rounded-lg ${toneClass}`}>
            {icon}
          </span>
        </div>
        <div className="mt-3 truncate font-mono text-2xl font-bold tabular-nums text-foreground">
          {value}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  )
}

export function InternalHomePage() {
  const t = useInternalT()
  const summary = useInternalRead<MrrSummary>("admin_mrr_summary", {})
  const tenants = useInternalRead<number>("admin_count_tenants", {})
  const series = useInternalRead<UsageSeriesRow[]>("admin_usage_series", {})

  const competencia = summary.data?.competencia ?? null
  const rows = series.data ?? []
  const lastCompetencia = rows.reduce<string | null>(
    (acc, row) => (acc === null || row.competencia > acc ? row.competencia : acc),
    null,
  )
  const currentEvents = rows.reduce(
    (acc, row) => (row.competencia === lastCompetencia ? acc + row.events : acc),
    0,
  )

  return (
    <div className="flex flex-col gap-6">
      <InternalPageHeader
        title={t("internalAdmin.home.title")}
        description={t("internalAdmin.home.description")}
      />

      {summary.failed ? <InternalErrorState onRetry={summary.reload} /> : null}

      {summary.loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <InternalLoadingState rows={2} />
        </div>
      ) : null}

      {summary.data !== null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label={t("internalAdmin.home.mrr")}
            value={formatCurrency(summary.data.mrr_cents)}
            hint={
              competencia === null
                ? t("internalAdmin.home.noCompetencia")
                : t("internalAdmin.home.competencia", { value: formatDate(competencia) })
            }
            tone="revenue"
            icon={<CircleDollarSign className="size-4" aria-hidden="true" />}
          />
          <KpiCard
            label={t("internalAdmin.home.active")}
            value={formatCount(summary.data.active_count)}
            hint={t("internalAdmin.home.activeHint")}
            tone="neutral"
            icon={<Users className="size-4" aria-hidden="true" />}
          />
          <KpiCard
            label={t("internalAdmin.home.pastDue")}
            value={formatCount(summary.data.past_due_count)}
            hint={t("internalAdmin.home.pastDueHint")}
            tone="attention"
            icon={<AlertTriangle className="size-4" aria-hidden="true" />}
          />
          <KpiCard
            label={t("internalAdmin.home.overdue")}
            value={formatCurrency(summary.data.overdue_cents)}
            hint={t("internalAdmin.home.overdueHint", {
              value: formatCount(summary.data.overdue_count),
            })}
            tone="expense"
            icon={<AlertTriangle className="size-4" aria-hidden="true" />}
          />
        </div>
      ) : null}

      <Card className="border-border/70 shadow-xs">
        <CardContent className="flex flex-col gap-4 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Building2 className="size-4" aria-hidden="true" />
            {t("internalAdmin.home.contextTitle")}
          </div>

          {tenants.failed || series.failed ? (
            <InternalErrorState
              onRetry={() => {
                tenants.reload()
                series.reload()
              }}
            />
          ) : null}

          {tenants.loading || series.loading ? <InternalLoadingState rows={2} /> : null}

          {tenants.data !== null && series.data !== null ? (
            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{t("internalAdmin.home.tenants")}</dt>
                <dd className="font-mono text-lg font-semibold tabular-nums text-foreground">
                  {formatCount(tenants.data)}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{t("internalAdmin.home.events")}</dt>
                <dd className="font-mono text-lg font-semibold tabular-nums text-foreground">
                  {formatCount(currentEvents)}
                </dd>
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {lastCompetencia === null
                    ? t("internalAdmin.states.emptyTitle")
                    : t("internalAdmin.home.competencia", { value: formatDate(lastCompetencia) })}
                </p>
              </div>
            </dl>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
