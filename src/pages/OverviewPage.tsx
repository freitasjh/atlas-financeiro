import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { ChartAreaInteractive } from "@/components/shadcn/dashboard/chart-area-interactive"
import { SectionCards } from "@/components/shadcn/dashboard/section-cards"
import { Button } from "@/components/shadcn/ui/button"
import { PageHeader } from "@/components/ui/PageHeader"
import { buildMonthlySeries, type MonthlySeriesPoint } from "@/lib/dashboard/series"
import { buildTopCategories, type TopCategory } from "@/lib/dashboard/top-categories"
import { toCents, type DashboardKpis, type DashboardKpiValues, type MtdWindow } from "@/lib/dashboard/types"
import type { DashboardTransaction } from "@/lib/dashboard/types"
import { supabase } from "@/lib/supabase"

const TOP_N = 5

function monthStart(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`
}

function mtdWindow(value: unknown, field: string): MtdWindow {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`dashboard: ${field} ausente`)
  }
  const raw = value as Record<string, unknown>
  const expense = raw.k2_realized_expense_cents ?? raw.k2
  const income = raw.k3_realized_income_cents ?? raw.k3
  return {
    from: String(raw.from),
    to: String(raw.to),
    k2_realized_expense_cents: toCents(expense, `${field}.k2`),
    k3_realized_income_cents: toCents(income, `${field}.k3`),
  }
}

/** RPC → tipos do domínio. Nenhum `*_cents` nulo é convertido em zero. */
function normalizeKpis(raw: unknown): DashboardKpis {
  if (typeof raw !== "object" || raw === null) {
    throw new TypeError("dashboard: resposta da RPC vazia")
  }
  const value = raw as Record<string, unknown>
  return {
    month: String(value.month),
    as_of: String(value.as_of),
    k1_liquidity_cents: toCents(value.k1_liquidity_cents, "k1_liquidity_cents"),
    k2_realized_expense_cents: toCents(value.k2_realized_expense_cents, "k2_realized_expense_cents"),
    k3_realized_income_cents: toCents(value.k3_realized_income_cents, "k3_realized_income_cents"),
    k4_open_invoices_cents: toCents(value.k4_open_invoices_cents, "k4_open_invoices_cents"),
    k5_projected_balance_cents: toCents(value.k5_projected_balance_cents, "k5_projected_balance_cents"),
    mtd_current: mtdWindow(value.mtd_current, "mtd_current"),
    mtd_previous: mtdWindow(value.mtd_previous, "mtd_previous"),
  }
}

/**
 * Rota "/" — KPIs da RPC (1 round-trip) + séries derivadas no cliente.
 * Nenhum dado mockado, nenhuma tabela de vitrine, nenhuma métrica SaaS.
 */
export function OverviewPage() {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [kpis, setKpis] = useState<DashboardKpis | null>(null)
  const [series, setSeries] = useState<MonthlySeriesPoint[]>([])
  const [topCategories, setTopCategories] = useState<TopCategory[]>([])
  const [hasAnyData, setHasAnyData] = useState(false)
  const [seriesHasData, setSeriesHasData] = useState(false)

  useEffect(() => {
    let active = true
    const now = new Date()
    const month = monthStart(now)

    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [rpcResult, accountsResult, transactionsResult] = await Promise.all([
          supabase.rpc("get_dashboard_kpis", { p_month: month }),
          supabase.from("accounts").select("id", { count: "exact", head: true }),
          supabase
            .from("transactions")
            .select("amount_cents, type, is_transfer, date, category_id"),
        ])
        if (rpcResult.error) throw rpcResult.error
        if (accountsResult.error) throw accountsResult.error
        if (transactionsResult.error) throw transactionsResult.error

        const transactions = (transactionsResult.data ?? []) as DashboardTransaction[]
        const accountCount = accountsResult.count ?? 0
        const nextKpis = normalizeKpis(rpcResult.data)
        const nextSeries = buildMonthlySeries(transactions, now)
        const nextTop = buildTopCategories(transactions, month.slice(0, 7), TOP_N)
        if (!active) return

        setKpis(nextKpis)
        setSeries(nextSeries)
        setTopCategories(nextTop)
        setHasAnyData(accountCount > 0 || transactions.length > 0)
        setSeriesHasData(transactions.length > 0)
      } catch {
        if (!active) return
        setKpis(null)
        setSeries([])
        setTopCategories([])
        setHasAnyData(false)
        setSeriesHasData(false)
        setError(true)
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [attempt])

  const retry = () => setAttempt((value) => value + 1)

  const values: DashboardKpiValues | null = useMemo(() => {
    if (!kpis) return null
    return {
      liquidityCents: kpis.k1_liquidity_cents,
      realizedExpenseCents: kpis.k2_realized_expense_cents,
      realizedIncomeCents: kpis.k3_realized_income_cents,
      openInvoicesCents: kpis.k4_open_invoices_cents,
      projectedBalanceCents: kpis.k5_projected_balance_cents,
      previousExpenseCents: kpis.mtd_previous.k2_realized_expense_cents,
      previousIncomeCents: kpis.mtd_previous.k3_realized_income_cents,
    }
  }, [kpis])

  return (
    <>
      <PageHeader title={t("dashboard.title")} subtitle={t("dashboard.subtitle")} />

      {loading ? (
        <>
          <SectionCards kpis={null} loading />
          <ChartAreaInteractive loading />
        </>
      ) : error ? (
        <div role="alert" className="px-4 pb-6 lg:px-6">
          <div className="flex min-h-36 flex-col items-start justify-center gap-3 rounded-[var(--radius)] border border-border/60 bg-card p-6">
            <p className="text-sm text-muted-foreground">{t("dashboard.loadError")}</p>
            <Button type="button" onClick={retry} className="min-h-11 px-4">
              {t("dashboard.retry")}
            </Button>
          </div>
        </div>
      ) : !hasAnyData ? (
        <div role="status" data-slot="dashboard-empty" className="px-4 pb-6 lg:px-6">
          <div className="flex min-h-36 items-center rounded-[var(--radius)] border border-border/60 bg-card p-6 text-sm text-muted-foreground">
            {t("dashboard.emptyPremium")}
          </div>
        </div>
      ) : (
        <>
          <SectionCards kpis={values} />
          <ChartAreaInteractive
            series={series}
            topCategories={topCategories}
            hasAnyData
            seriesHasData={seriesHasData}
            topHasData={topCategories.length > 0}
          />
        </>
      )}
    </>
  )
}

export default OverviewPage
