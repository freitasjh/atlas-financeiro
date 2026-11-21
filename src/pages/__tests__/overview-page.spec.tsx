// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { I18nextProvider } from "react-i18next"

const { rpc, from } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({ supabase: { rpc, from } }))

import i18n from "@/i18n"
import { OverviewPage } from "@/pages/OverviewPage"

const now = new Date()
const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
const today = now.toISOString().slice(0, 10)

function kpis(overrides: Record<string, unknown> = {}) {
  return {
    month: `${monthKey}-01`,
    as_of: today,
    k1_liquidity_cents: 12509000,
    k2_realized_expense_cents: 340000,
    k3_realized_income_cents: 800000,
    k4_open_invoices_cents: 50000,
    k5_projected_balance_cents: 12700000,
    mtd_current: {
      from: `${monthKey}-01`,
      to: today,
      k2_realized_expense_cents: 340000,
      k3_realized_income_cents: 800000,
    },
    mtd_previous: {
      from: "2026-10-01",
      to: "2026-10-21",
      k2_realized_expense_cents: 310000,
      k3_realized_income_cents: 750000,
    },
    ...overrides,
  }
}

function mockSources(options: { accountCount?: number; transactions?: unknown[] } = {}) {
  const accountCount = options.accountCount ?? 1
  const transactions = options.transactions ?? [
    {
      amount_cents: 1200,
      type: "expense",
      is_transfer: false,
      date: `${monthKey}-05`,
      category_id: "cat-a",
    },
  ]
  from.mockImplementation((table: string) => ({
    select: vi.fn().mockResolvedValue(
      table === "accounts"
        ? { data: accountCount ? [{ id: "acc-1" }] : [], count: accountCount, error: null }
        : { data: transactions, count: transactions.length, error: null },
    ),
  }))
}

function renderPage() {
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
  rpc.mockResolvedValue({ data: kpis(), error: null })
  mockSources()
})

afterEach(() => cleanup())

describe("DASH-13 — rota / com dados reais", () => {
  it("sem mocks/DataTable na rota e KPIs formatados a partir da RPC", async () => {
    const source = readFileSync(join(__dirname, "..", "OverviewPage.tsx"), "utf8")
    for (const forbidden of ["data.json", "<DataTable", "R$ 1,25M", "Novos clientes", "MRR", "NRR"]) {
      expect(source, `mock residual: ${forbidden}`).not.toContain(forbidden)
    }

    const { container } = renderPage()
    expect(await screen.findByText("R$ 125.090,00")).toBeTruthy()
    expect(container.textContent).not.toContain("R$ 1,25M")
    expect(container.textContent).not.toContain("Novos clientes")
    expect(rpc).toHaveBeenCalledWith("get_dashboard_kpis", { p_month: `${monthKey}-01` })
  })

  it("grid de 5 colunas com G1 em xl:col-span-7 e G2 em xl:col-span-5", async () => {
    const { container } = renderPage()
    await screen.findByText("R$ 125.090,00")

    const kpiGrid = container.querySelector('[data-slot="kpi-grid"]')
    expect(kpiGrid?.className).toContain("grid-cols-1")
    expect(kpiGrid?.className).toContain("sm:grid-cols-2")
    expect(kpiGrid?.className).toContain("lg:grid-cols-5")

    const chartGrid = container.querySelector('[data-slot="chart-grid"]')
    expect(chartGrid?.className).toContain("xl:grid-cols-12")
    expect(container.querySelector('[data-slot="curve-panel"]')?.className).toContain("xl:col-span-7")
    expect(container.querySelector('[data-slot="top-panel"]')?.className).toContain("xl:col-span-5")
  })

  it("Δ apenas em K2/K3; K1/K4/K5 sem badge", async () => {
    renderPage()
    await screen.findByText("R$ 125.090,00")
    expect(screen.getAllByTestId("kpi-delta-chip")).toHaveLength(2)
    for (const label of [
      i18n.t("dashboard.liquidity"),
      i18n.t("dashboard.openInvoices"),
      i18n.t("dashboard.projectedBalance"),
    ]) {
      const card = screen.getByText(label).closest('[data-slot="kpi-card"]') as HTMLElement
      expect(card.querySelector('[data-slot="kpi-delta"]')).toBeNull()
    }
  })

  it("com mtd_previous zerado não exibe badge de tendência", async () => {
    rpc.mockResolvedValue({
      data: kpis({
        mtd_previous: {
          from: "2026-10-01",
          to: "2026-10-21",
          k2_realized_expense_cents: 0,
          k3_realized_income_cents: 0,
        },
      }),
      error: null,
    })
    renderPage()
    await screen.findByText("R$ 125.090,00")
    expect(screen.queryByTestId("kpi-delta-chip")).toBeNull()
  })

  it("carregamento mostra skeleton com altura reservada", () => {
    let resolveRpc: (value: unknown) => void = () => undefined
    rpc.mockReturnValue(new Promise((resolve) => (resolveRpc = resolve)))
    const { container } = renderPage()

    const grid = container.querySelector('[data-slot="kpi-grid"]')
    expect(grid?.getAttribute("aria-busy")).toBe("true")
    expect(container.querySelector(".min-h-36")?.className).toContain("motion-reduce:animate-none")

    resolveRpc({ data: kpis(), error: null })
  })

  it("erro mostra dashboard.loadError + retry funcional", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "rpc indisponível" } })
    renderPage()

    const message = await screen.findByText(i18n.t("dashboard.loadError"))
    expect(message).toBeTruthy()
    const retry = screen.getByRole("button", { name: i18n.t("dashboard.retry") })
    expect(retry.className).toMatch(/min-h-11/)
    fireEvent.click(retry)
    await screen.findByText("R$ 125.090,00")
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it("vazio por ausência de linhas: emptyPremium global único, sem curveEmpty/topEmpty", async () => {
    rpc.mockResolvedValue({ data: kpis({ k1_liquidity_cents: 0, k2_realized_expense_cents: 0 }), error: null })
    mockSources({ accountCount: 0, transactions: [] })
    renderPage()

    expect(await screen.findByText(i18n.t("dashboard.emptyPremium"))).toBeTruthy()
    expect(screen.queryByText(i18n.t("dashboard.curveEmpty"))).toBeNull()
    expect(screen.queryByText(i18n.t("dashboard.topEmpty"))).toBeNull()
  })

  it("valor zero com linhas existentes não dispara empty global; charts mostram seus vazios locais", async () => {
    rpc.mockResolvedValue({ data: kpis({ k1_liquidity_cents: 0, k2_realized_expense_cents: 0 }), error: null })
    mockSources({ accountCount: 1, transactions: [] })
    renderPage()

    await screen.findAllByText("R$ 0,00")
    expect(screen.queryByText(i18n.t("dashboard.emptyPremium"))).toBeNull()
    expect(screen.getByText(i18n.t("dashboard.curveEmpty"))).toBeTruthy()
    expect(screen.getByText(i18n.t("dashboard.topEmpty"))).toBeTruthy()
  })
})
