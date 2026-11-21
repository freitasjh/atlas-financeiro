import { useEffect, useState } from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Area, AreaChart } from "recharts"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/shadcn/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/shadcn/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/shadcn/ui/chart"
import { Skeleton } from "@/components/shadcn/ui/skeleton"
import { formatAxisCents, formatAxisNumber } from "@/lib/dashboard/axis"
import { formatCents, resolveDashboardLocale } from "@/lib/dashboard/format"
import type { MonthlySeriesPoint } from "@/lib/dashboard/series"
import type { TopCategory } from "@/lib/dashboard/top-categories"

export type ChartAreaInteractiveProps = {
  /** G1 — série de 12 meses (DASH-09). */
  series?: MonthlySeriesPoint[]
  /** G2 — top categorias do mês corrente (DASH-10). */
  topCategories?: TopCategory[]
  /** `false` = nenhuma conta e nenhuma transação: empty global único. */
  hasAnyData?: boolean
  /** Presença de linhas reais — vazio do gráfico nunca é decidido por valor 0. */
  seriesHasData?: boolean
  topHasData?: boolean
  loading?: boolean
  error?: boolean
  onRetry?: () => void
}

// Cursor/animation: prefers-reduced-motion desliga a animação do Recharts.
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener?.("change", onChange)
    return () => query.removeEventListener?.("change", onChange)
  }, [])
  return reduced
}

function monthLabel(month: string, locale: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(locale, { month: "short", timeZone: "UTC" })
}

function PanelState({
  message,
  retryLabel,
  onRetry,
  slot,
}: {
  message: string
  retryLabel: string
  onRetry?: () => void
  slot: string
}) {
  return (
    <div
      data-slot={slot}
      role={onRetry ? "alert" : "status"}
      className="col-span-full flex min-h-64 flex-col items-start justify-center gap-3 rounded-[var(--radius)] border border-border/60 bg-card p-6"
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

function ChartSkeleton({ slot }: { slot: string }) {
  return (
    <div data-slot={slot} className="min-w-0 rounded-[var(--radius)] border border-border/60 p-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="mt-4 min-h-[260px] w-full motion-reduce:animate-none" />
    </div>
  )
}

/** G1 (evolução mensal) e G2 (top categorias) sobre transações reais do usuário. */
export function ChartAreaInteractive({
  series = [],
  topCategories = [],
  hasAnyData = true,
  seriesHasData,
  topHasData,
  loading = false,
  error = false,
  onRetry,
}: ChartAreaInteractiveProps) {
  const { t, i18n } = useTranslation()
  const locale = resolveDashboardLocale(i18n.language)
  const reducedMotion = usePrefersReducedMotion()

  const curveConfig = {
    income: { label: t("dashboard.income"), color: "var(--chart-2)" },
    expense: { label: t("dashboard.spent"), color: "var(--chart-1)" },
  } satisfies ChartConfig
  const topConfig = {
    total: { label: t("dashboard.spent"), color: "var(--chart-1)" },
  } satisfies ChartConfig

  // Recharts exige número para geometria; o valor segue em CÊNTIMOS inteiros
  // e só é dividido dentro de formatCents/formatCentsCompact.
  const curveData = series.map((point) => ({
    month: point.month,
    income: Number(point.income_cents),
    expense: Number(point.expense_cents),
  }))
  const topData = topCategories.map((category) => ({
    category: category.category_id ?? t("transactions.noCategory"),
    total: Number(category.total_cents),
  }))

  const totalIncome = series.reduce((sum, point) => sum + point.income_cents, 0n)
  const totalExpense = series.reduce((sum, point) => sum + point.expense_cents, 0n)
  const topTotal = topCategories.reduce((sum, item) => sum + item.total_cents, 0n)
  const hasCurve =
    seriesHasData ?? series.some((point) => point.income_cents !== 0n || point.expense_cents !== 0n)
  const hasTop = topHasData ?? topCategories.length > 0

  if (loading) {
    return (
      <div data-slot="chart-grid" aria-busy="true" className="grid grid-cols-1 gap-4 px-4 pb-6 lg:px-6 xl:grid-cols-12">
        <ChartSkeleton slot="curve-panel" />
        <ChartSkeleton slot="top-panel" />
      </div>
    )
  }

  if (error || !hasAnyData) {
    return (
      <div data-slot="chart-grid" className="grid grid-cols-1 gap-4 px-4 pb-6 lg:px-6 xl:grid-cols-12">
        <PanelState
          slot="dashboard-state"
          message={t(error ? "dashboard.loadError" : "dashboard.emptyPremium")}
          retryLabel={t("dashboard.retry")}
          onRetry={error ? onRetry : undefined}
        />
      </div>
    )
  }

  return (
    <div data-slot="chart-grid" className="grid grid-cols-1 gap-4 px-4 pb-6 lg:px-6 xl:grid-cols-12">
      <Card data-slot="curve-panel" className="min-w-0 xl:col-span-7">
        <CardHeader>
          <CardTitle>{t("dashboard.curve")}</CardTitle>
          <CardDescription>
            <span className="font-mono tabular-nums">
              {t("dashboard.cashflowSummary", {
                count: series.length,
                income: formatCents(totalIncome, locale),
                spent: formatCents(totalExpense, locale),
              })}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="px-2 pt-2 sm:px-6">
          {!hasCurve ? (
            <div
              role="status"
              className="flex min-h-[260px] items-center justify-center text-sm text-muted-foreground"
            >
              {t("dashboard.curveEmpty")}
            </div>
          ) : (
            <ChartContainer
              config={curveConfig}
              role="img"
              aria-label={t("dashboard.curveLabel")}
              className="min-h-[260px] w-full"
            >
              <AreaChart data={curveData} accessibilityLayer margin={{ left: 0, right: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="month"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={(value) => monthLabel(String(value), locale)}
                />
                <YAxis
                  width={80}
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  tick={{ className: "font-mono tabular-nums" }}
                  tickFormatter={(value) => formatAxisCents(value, locale)}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      indicator="dot"
                      formatter={(value) =>
                        typeof value === "number"
                          ? formatCents(BigInt(Math.trunc(value)), locale)
                          : String(value)
                      }
                    />
                  }
                />
                <Area
                  dataKey="expense"
                  type="natural"
                  fill="var(--color-expense)"
                  fillOpacity={0.2}
                  stroke="var(--color-expense)"
                  isAnimationActive={!reducedMotion}
                />
                <Area
                  dataKey="income"
                  type="natural"
                  fill="var(--color-income)"
                  fillOpacity={0.2}
                  stroke="var(--color-income)"
                  isAnimationActive={!reducedMotion}
                />
              </AreaChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Card data-slot="top-panel" className="min-w-0 xl:col-span-5">
        <CardHeader>
          <CardTitle>{t("dashboard.topCategories")}</CardTitle>
          <CardDescription>
            <span className="font-mono tabular-nums">
              {t("dashboard.topSummary", {
                count: topData.length,
                total: formatCents(topTotal, locale),
              })}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="px-2 pt-2 sm:px-6">
          {!hasTop ? (
            <div
              role="status"
              className="flex min-h-[260px] items-center justify-center text-sm text-muted-foreground"
            >
              {t("dashboard.topEmpty")}
            </div>
          ) : (
            <ChartContainer
              config={topConfig}
              role="img"
              aria-label={t("dashboard.topSummary", {
                count: topData.length,
                total: formatCents(topTotal, locale),
              })}
              className="min-h-[260px] w-full"
            >
              <BarChart data={topData} layout="vertical" accessibilityLayer margin={{ right: 40 }}>
                <CartesianGrid horizontal={false} />
                <XAxis
                  type="number"
                  allowDecimals={false}
                  interval="preserveStartEnd"
                  tickCount={3}
                  minTickGap={24}
                  tickLine={false}
                  axisLine={false}
                  tick={{ className: "font-mono tabular-nums" }}
                  tickFormatter={(value) => formatAxisNumber(value, locale)}
                />
                <YAxis
                  type="category"
                  dataKey="category"
                  width={104}
                  tickLine={false}
                  axisLine={false}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      indicator="dot"
                      formatter={(value) =>
                        typeof value === "number"
                          ? formatCents(BigInt(Math.trunc(value)), locale)
                          : String(value)
                      }
                    />
                  }
                />
                <Bar dataKey="total" fill="var(--color-total)" radius={4} isAnimationActive={!reducedMotion} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
