import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/shadcn/ui/badge"
import { Button } from "@/components/shadcn/ui/button"
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/shadcn/ui/card"
import { Skeleton } from "@/components/shadcn/ui/skeleton"
import { cn } from "@/lib/cn"
import { formatCents, resolveDashboardLocale } from "@/lib/dashboard/format"
import type { DashboardKpiValues } from "@/lib/dashboard/types"

export type SectionCardsProps = {
  /** `null` = ausência de linhas (empty global), nunca "valor zero". */
  kpis: DashboardKpiValues | null
  loading?: boolean
  error?: boolean
  onRetry?: () => void
}

type Tone = "rose" | "emerald" | "muted"

const TONE_CLASS: Record<Tone, string> = {
  rose: "text-rose-700 dark:text-rose-300",
  emerald: "text-emerald-700 dark:text-emerald-300",
  muted: "text-muted-foreground",
}

type Delta = { tone: Tone; label: string; icon: typeof ArrowUpRight }

function computeDelta(
  kind: "expense" | "income",
  current: bigint,
  previous: bigint,
  locale: string,
  flatLabel: string,
): Delta | null {
  // UX E2: base zero não tem variação percentual definida — sem badge.
  if (previous === 0n) return null
  if (current === previous) {
    return { tone: "muted", label: flatLabel, icon: Minus }
  }
  const up = current > previous
  const favorable = kind === "expense" ? !up : up
  const basisPoints = (((current - previous) * 10000n) / previous).toString()
  const ratio = Number(basisPoints) / 10000
  const label = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(ratio)
  return {
    tone: favorable ? "emerald" : "rose",
    label,
    icon: up ? ArrowUpRight : ArrowDownRight,
  }
}

function KpiCard({
  label,
  value,
  hint,
  delta,
  testId,
}: {
  label: string
  value: string
  hint: string
  delta?: Delta | null
  testId: string
}) {
  const Icon = delta?.icon
  return (
    <div
      data-slot="kpi-card"
      data-kpi={testId}
      className="min-w-0 rounded-[calc(var(--radius)+0.375rem)] border border-border/50 bg-muted/30 p-1.5"
    >
      <Card className="relative h-full min-h-36 gap-3 overflow-hidden rounded-[var(--radius)] border-border/60 bg-card">
        <CardHeader className="gap-1">
          <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </CardDescription>
          <CardTitle className="font-mono text-xl font-semibold tracking-tight whitespace-nowrap tabular-nums @[250px]/card:text-2xl">
            {value}
          </CardTitle>
          {delta ? (
            <div data-slot="kpi-delta" className="pt-0.5">
              <Badge
                variant="outline"
                data-testid="kpi-delta-chip"
                className={cn("gap-1 rounded-full px-2 py-0.5 text-xs font-medium", TONE_CLASS[delta.tone])}
              >
                {Icon ? <Icon className="size-3.5" aria-hidden="true" /> : null}
                {delta.label}
              </Badge>
            </div>
          ) : null}
        </CardHeader>
        <CardFooter className="pt-0 text-xs text-muted-foreground">{hint}</CardFooter>
      </Card>
    </div>
  )
}

function LoadingGrid() {
  return (
    <>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="min-w-0 rounded-[var(--radius)] border border-border/50 p-1.5">
          <Skeleton className="min-h-36 w-full motion-reduce:animate-none" />
        </div>
      ))}
    </>
  )
}

function StatePanel({
  message,
  onRetry,
  retryLabel,
}: {
  message: string
  onRetry?: () => void
  retryLabel: string
}) {
  return (
    <div
      role={onRetry ? "alert" : "status"}
      className="col-span-full flex min-h-36 flex-col items-start justify-center gap-3 rounded-[var(--radius)] border border-border/60 bg-card p-6"
    >
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry ? (
        <Button type="button" onClick={onRetry} className="min-h-11 px-4">
          {retryLabel}
        </Button>
      ) : null}
    </div>
  )
}

/** K1–K5 (ADR §4.2). Δ apenas em K2/K3, com favorabilidade por tipo. */
export function SectionCards({ kpis, loading = false, error = false, onRetry }: SectionCardsProps) {
  const { t, i18n } = useTranslation()
  const locale = resolveDashboardLocale(i18n.language)
  const format = (cents: bigint) => formatCents(cents, locale)

  const expenseDelta = kpis
    ? computeDelta(
        "expense",
        kpis.realizedExpenseCents,
        kpis.previousExpenseCents,
        locale,
        t("dashboard.deltaFlat"),
      )
    : null
  const incomeDelta = kpis
    ? computeDelta(
        "income",
        kpis.realizedIncomeCents,
        kpis.previousIncomeCents,
        locale,
        t("dashboard.deltaFlat"),
      )
    : null

  return (
    <div
      data-slot="kpi-grid"
      aria-busy={loading || undefined}
      className="grid grid-cols-1 gap-4 px-4 sm:grid-cols-2 lg:grid-cols-5 lg:px-6"
    >
      {loading ? <LoadingGrid /> : null}
      {!loading && error ? (
        <StatePanel
          message={t("dashboard.loadError")}
          retryLabel={t("dashboard.retry")}
          onRetry={onRetry}
        />
      ) : null}
      {!loading && !error && kpis === null ? (
        <StatePanel message={t("dashboard.emptyPremium")} retryLabel={t("dashboard.retry")} />
      ) : null}
      {!loading && !error && kpis ? (
        <>
          <KpiCard
            testId="liquidity"
            label={t("dashboard.liquidity")}
            value={format(kpis.liquidityCents)}
            hint={t("dashboard.balanceFirst")}
          />
          <KpiCard
            testId="expense"
            label={t("dashboard.spent")}
            value={format(kpis.realizedExpenseCents)}
            hint={t("dashboard.realizedHint")}
            delta={expenseDelta}
          />
          <KpiCard
            testId="income"
            label={t("dashboard.income")}
            value={format(kpis.realizedIncomeCents)}
            hint={t("dashboard.realizedHint")}
            delta={incomeDelta}
          />
          <KpiCard
            testId="invoices"
            label={t("dashboard.openInvoices")}
            value={format(kpis.openInvoicesCents)}
            hint={t("dashboard.openInvoicesCount")}
          />
          <KpiCard
            testId="projected"
            label={t("dashboard.projectedBalance")}
            value={format(kpis.projectedBalanceCents)}
            hint={t("dashboard.forecastedHint")}
          />
        </>
      ) : null}
    </div>
  )
}
