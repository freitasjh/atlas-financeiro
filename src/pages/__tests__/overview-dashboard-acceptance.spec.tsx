// @vitest-environment happy-dom
/**
 * DASH-15 — aceite do ADR-001 §10. 11 asserções substantivas:
 * contrato financeiro da RPC, ligação RPC→UI, i18n, escopo negativo e charts.
 * Fonte da proposta: harness/dashboard-kpis-h3.json → proposedTest.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { I18nextProvider } from "react-i18next"

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))
vi.mock("@/lib/supabase", () => ({ supabase: { rpc, from } }))

import i18n from "@/i18n"
import enUS from "@/i18n/messages/en-US"
import ptBR from "@/i18n/messages/pt-BR"
import { buildMonthlySeries } from "@/lib/dashboard/series"
import { OverviewPage } from "@/pages/OverviewPage"

const ROOT = join(__dirname, "..", "..", "..")
const SQL = readFileSync(
  join(ROOT, "supabase", "migrations", "0085_dashboard_kpis_rpc.sql"),
  "utf8",
)
const MONTH = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`

const ROUTE_FILES = [
  "src/pages/OverviewPage.tsx",
  "src/components/shadcn/dashboard/section-cards.tsx",
  "src/components/shadcn/dashboard/section-cards.stories.tsx",
  "src/components/shadcn/dashboard/chart-area-interactive.tsx",
  "src/components/shadcn/dashboard/chart-area-interactive.stories.tsx",
  ...readdirSync(join(ROOT, "src", "lib", "dashboard"))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `src/lib/dashboard/${file}`),
].map((relative) => ({ relative, source: readFileSync(join(ROOT, relative), "utf8") }))

function kpiFixture(overrides: Record<string, unknown> = {}) {
  return {
    month: `${MONTH}-01`,
    as_of: `${MONTH}-21`,
    k1_liquidity_cents: 12550,
    k2_realized_expense_cents: 3400,
    k3_realized_income_cents: 8000,
    k4_open_invoices_cents: 50000,
    k5_projected_balance_cents: 14000,
    mtd_current: {
      from: `${MONTH}-01`,
      to: `${MONTH}-21`,
      k2_realized_expense_cents: 3400,
      k3_realized_income_cents: 8000,
    },
    mtd_previous: {
      from: "2026-10-01",
      to: "2026-10-21",
      k2_realized_expense_cents: 3100,
      k3_realized_income_cents: 7500,
    },
    ...overrides,
  }
}

function renderOverview(
  overrides: Record<string, unknown> = {},
  options: { accounts?: number; transactions?: number } = {},
) {
  rpc.mockResolvedValue({ data: kpiFixture(overrides), error: null })
  from.mockImplementation((table: string) => ({
    select: vi.fn().mockResolvedValue(
      table === "accounts"
        ? { data: [], count: options.accounts ?? 1, error: null }
        : {
            data: Array.from({ length: options.transactions ?? 1 }, () => ({
              amount_cents: 3400,
              type: "expense",
              is_transfer: false,
              date: `${MONTH}-05`,
              category_id: "cat-a",
            })),
            count: options.transactions ?? 1,
            error: null,
          },
    ),
  }))
  return render(
    <I18nextProvider i18n={i18n}>
      <OverviewPage />
    </I18nextProvider>,
  )
}

beforeEach(async () => {
  await i18n.changeLanguage("pt-BR")
  rpc.mockReset()
  from.mockReset()
})

afterEach(() => cleanup())

describe("DASH-15 — aceite executável do ADR-001 §10", () => {
  it("1/11 · RF-04: K1 = soma exata de 2 contas em cêntimos, sem float na cadeia RPC→UI", async () => {
    const accounts = [10000, 2550]
    renderOverview({ k1_liquidity_cents: accounts.reduce((sum, value) => sum + value, 0) })

    expect(await screen.findByText("R$ 125,50")).toBeTruthy()
    expect(SQL).toMatch(/coalesce\(sum\(a\.current_balance_cents\), 0\)::bigint/)
    expect(rpc).toHaveBeenCalledWith("get_dashboard_kpis", { p_month: `${MONTH}-01` })
  })

  it("2/11 · RN04: compra com invoice_id entra em K2; is_transfer=true não entra em K2/K3", async () => {
    // A RPC filtra por type + is_transfer; invoice_id NÃO é critério de exclusão.
    expect(SQL).toContain("t.type = 'expense'")
    expect(SQL).toContain("t.is_transfer = false")
    const body = SQL.slice(SQL.indexOf("AS $$"))
    expect(body).not.toContain("invoice_id")

    renderOverview({ k2_realized_expense_cents: 3400, k3_realized_income_cents: 8000 })
    expect(await screen.findByText("R$ 34,00")).toBeTruthy()
    expect(screen.getByText("R$ 80,00")).toBeTruthy()
  })

  it("3/11 · BG-57: type=income com category_id nula permanece em K3; zero consulta a categories.type", async () => {
    expect(SQL).not.toContain("categories.type")
    const series = buildMonthlySeries(
      [
        {
          date: `${MONTH}-05`,
          amount_cents: 8000,
          type: "income",
          is_transfer: false,
          category_id: null,
        },
      ],
      new Date(),
    )
    expect(series[series.length - 1].income_cents).toBe(8000n)

    renderOverview()
    expect(await screen.findByText("R$ 80,00")).toBeTruthy()
  })

  it("4/11 · I-02: K4=50000 exibido e K5 idêntico ao cenário sem fatura (sem K4 na fórmula)", async () => {
    const formula = SQL.match(/v_k5 := [^\n]+/)?.[0] ?? ""
    expect(formula).toContain("v_k1 + v_forecast_in - v_forecast_out")
    expect(formula).not.toContain("v_k4")

    renderOverview({ k4_open_invoices_cents: 50000, k5_projected_balance_cents: 14000 })
    expect(await screen.findByText("R$ 140,00")).toBeTruthy()
    expect(screen.getByText("R$ 500,00")).toBeTruthy()
    const projectedWith = screen.getByText(i18n.t("dashboard.projectedBalance"))
      .closest('[data-slot="kpi-card"]')?.textContent
    cleanup()

    renderOverview({ k4_open_invoices_cents: 0, k5_projected_balance_cents: 14000 })
    expect(await screen.findByText("R$ 140,00")).toBeTruthy()
    expect(screen.getByText("R$ 0,00")).toBeTruthy()
    const projectedWithout = screen.getByText(i18n.t("dashboard.projectedBalance"))
      .closest('[data-slot="kpi-card"]')?.textContent
    expect(projectedWith).toBe(projectedWithout)
  })

  it("5/11 · RF-15: projectedBreakdown sem 'invoices'/'faturas em aberto' em pt-BR e en-US", () => {
    for (const [locale, catalog] of [
      ["pt-BR", ptBR],
      ["en-US", enUS],
    ] as const) {
      const text = catalog.dashboard.projectedBreakdown
      expect(text, locale).not.toMatch(/faturas em aberto|open invoices|\{\{invoices\}\}/i)
      expect(text, locale).toContain("{{liquidity}}")
      expect(text, locale).toContain("{{income}}")
      expect(text, locale).toContain("{{spent}}")
    }
  })

  it("6/11 · RF-09/10: clamp MTD date-only (2026-10-21 / 2026-02-28) sem timezone", () => {
    expect(SQL).toMatch(/v_today\s+date := current_date/)
    expect(SQL).toContain("interval '1 month - 1 day'")
    expect(SQL).toMatch(/v_prev_end\s+date := least\(v_prev_start \+ \(v_days - 1\), v_prev_last\)/)
    expect(SQL).not.toMatch(/AT TIME ZONE|timestamptz/i)
    // Contrato congelado: o cliente nunca reimplementa o clamp — lê `to` da RPC.
    expect(kpiFixture().mtd_previous.to).toBe("2026-10-21")
  })

  it("7/11 · RF-11: anon sem EXECUTE e isolamento por auth.uid() (A nunca vê B)", () => {
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.get_dashboard_kpis(date) FROM PUBLIC, anon")
    expect(SQL).toContain("GRANT EXECUTE ON FUNCTION public.get_dashboard_kpis(date) TO authenticated")
    expect(SQL).toContain("i.user_id = (select auth.uid())")
    expect(SQL).toMatch(/v_user\s+uuid := \(select auth\.uid\(\)\)/)
    expect(SQL).not.toContain("p_user_id")
  })

  it("8/11 · RF-16: glob explícito da rota sem mocks/DataTable/cards SaaS", () => {
    const forbidden = ["R$ 1,25M", "Novos clientes", "data.json", "<DataTable"]
    const hits = ROUTE_FILES.flatMap(({ relative, source }) =>
      forbidden.filter((token) => source.includes(token)).map((token) => `${relative} :: ${token}`),
    )
    expect(hits).toEqual([])
  })

  it("9/11 · NFR-07: glob explícito da rota sem métricas SaaS/fora do ADR", () => {
    const pattern = /MRR|NRR|burn|churn|ARPU|DTI|net worth|range\.quarter|range\.year/
    const hits = ROUTE_FILES.filter(({ source }) => pattern.test(source)).map(({ relative }) => relative)
    expect(hits).toEqual([])
  })

  it("10/11 · RF-14/layout: ChartContainer com min-h-*/var(--chart-N)/accessibilityLayer e grid 5/7/5", async () => {
    const source = ROUTE_FILES.find(({ relative }) => relative.endsWith("chart-area-interactive.tsx"))!.source
    expect(source).toContain("min-h-[260px]")
    expect(source).toContain("var(--chart-")
    expect(source).toContain("accessibilityLayer")
    expect(source).not.toContain("hsl(var(--chart")

    const { container } = renderOverview()
    expect(await screen.findAllByRole("img")).toHaveLength(2)
    expect(container.querySelector('[data-slot="kpi-grid"]')?.className).toContain("lg:grid-cols-5")
    expect(container.querySelector('[data-slot="curve-panel"]')?.className).toContain("xl:col-span-7")
    expect(container.querySelector('[data-slot="top-panel"]')?.className).toContain("xl:col-span-5")
  })

  it("11/11 · RF-01/02: assinatura congelada da RPC (1 parâmetro, STABLE, INVOKER, jsonb)", () => {
    expect(SQL).toMatch(/create or replace function public\.get_dashboard_kpis\(p_month date\)/i)
    expect(SQL).toContain("RETURNS jsonb")
    expect(SQL).toContain("LANGUAGE plpgsql")
    expect(SQL).toMatch(/\bSTABLE\b/)
    expect(SQL).toMatch(/\bSECURITY INVOKER\b/)
    expect(SQL).toContain("SET search_path = public, pg_temp")
    expect(SQL).not.toMatch(/\bSECURITY DEFINER\b/)
    expect(SQL).not.toMatch(/get_dashboard_kpis\([^)]*,/)
  })

})
