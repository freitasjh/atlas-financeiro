// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ComponentProps } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { I18nextProvider } from "react-i18next"

import i18n from "@/i18n"
import type { DashboardKpiValues } from "@/lib/dashboard/types"
import type { MonthlySeriesPoint } from "@/lib/dashboard/series"
import type { TopCategory } from "@/lib/dashboard/top-categories"
import { ChartAreaInteractive } from "../chart-area-interactive"
import { formatAxisCents, formatAxisNumber } from "@/lib/dashboard/axis"
import { SectionCards } from "../section-cards"

const COMPONENT_DIR = join(__dirname, "..")

const KPIS: DashboardKpiValues = {
  liquidityCents: 12509000n,
  realizedExpenseCents: 340000n,
  realizedIncomeCents: 800000n,
  openInvoicesCents: 50000n,
  projectedBalanceCents: 12700000n,
  previousExpenseCents: 310000n,
  previousIncomeCents: 750000n,
}

const SERIES: MonthlySeriesPoint[] = [
  { month: "2026-10", income_cents: 1000n, expense_cents: 500n },
  { month: "2026-11", income_cents: 2000n, expense_cents: 700n },
]

const TOPS: TopCategory[] = [
  { category_id: "cat-a", total_cents: 3000n },
  { category_id: null, total_cents: 1000n },
]

function renderCards(overrides: Partial<ComponentProps<typeof SectionCards>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SectionCards kpis={KPIS} {...overrides} />
    </I18nextProvider>,
  )
}

function renderCharts(overrides: Partial<ComponentProps<typeof ChartAreaInteractive>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ChartAreaInteractive series={SERIES} topCategories={TOPS} hasAnyData {...overrides} />
    </I18nextProvider>,
  )
}

function cardFor(label: string): HTMLElement {
  const node = screen.getByText(label).closest('[data-slot="kpi-card"]')
  if (!node) throw new Error(`card não encontrado: ${label}`)
  return node as HTMLElement
}

beforeEach(async () => {
  await i18n.changeLanguage("pt-BR")
})

afterEach(() => {
  cleanup()
})

describe("DASH-11 — wrapper shadcn/Recharts e tokens", () => {
  it("usa ChartContainer com var(--chart-N), min-h-* e accessibilityLayer; sem hex/hsl v2", () => {
    const source = readFileSync(join(COMPONENT_DIR, "chart-area-interactive.tsx"), "utf8")
    expect(source).toContain("var(--chart-")
    expect(source).toMatch(/min-h-\[/)
    expect(source).toContain("accessibilityLayer")
    expect(source).not.toContain("hsl(var(--chart")
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(source).not.toContain("data.json")
  })

  it("expõe role=img e aria-label nos dois gráficos e usa font-mono tabular-nums", () => {
    const { container } = renderCharts()
    const images = screen.getAllByRole("img")
    expect(images).toHaveLength(2)
    for (const image of images) {
      expect(image.getAttribute("aria-label")?.length).toBeGreaterThan(0)
    }
    expect(container.querySelector(".font-mono.tabular-nums")).not.toBeNull()
  })

  it("renderiza séries e top categorias reais (sem mock)", () => {
    const { container } = renderCharts()
    expect(container.textContent).not.toContain("R$ 1,25M")
    expect(container.textContent).not.toContain("Novos clientes")
    expect(container.textContent).not.toContain("desktop")
  })

  // Review Batch 2 — 🔴: ticks decimais (0.25/0.5/0.75) quebravam BigInt(value).
  it("regressão: domínio de 1 a 3 cêntimos renderiza G1/G2 sem RangeError", () => {
    const tinySeries: MonthlySeriesPoint[] = [
      { month: "2026-10", income_cents: 1n, expense_cents: 2n },
      { month: "2026-11", income_cents: 2n, expense_cents: 3n },
    ]
    const tinyTops: TopCategory[] = [
      { category_id: "cat-a", total_cents: 1n },
      { category_id: "cat-b", total_cents: 2n },
      { category_id: null, total_cents: 3n },
    ]

    expect(() =>
      renderCharts({ series: tinySeries, topCategories: tinyTops, hasAnyData: true }),
    ).not.toThrow()
    expect(screen.getAllByRole("img")).toHaveLength(2)

    // happy-dom não gera ticks decimais; contraprova direta no formatador do eixo.
    expect(formatAxisCents(0.25, "pt-BR")).toBe("R$ 0")
    expect(formatAxisCents(0.5, "pt-BR")).toBe("R$ 0")
    expect(formatAxisCents(100, "pt-BR")).toBe("R$ 1")
    expect(formatAxisNumber(0.75, "pt-BR")).toBe("1")
    expect(formatAxisNumber(3, "pt-BR")).toBe("3")
  })

  it("regressão 🟡: G2 usa ticks compactos sem prefixo de moeda e intervalo preservado", () => {
    const source = readFileSync(join(COMPONENT_DIR, "chart-area-interactive.tsx"), "utf8")
    const barAxis = source.slice(source.indexOf("<XAxis", source.indexOf("<BarChart")))
    expect(barAxis).toContain('allowDecimals={false}')
    expect(barAxis).toContain('interval="preserveStartEnd"')
    expect(barAxis).toContain("formatAxisNumber(value, locale)")
    expect(barAxis).not.toContain("formatCentsCompact(BigInt(value)")
    const axisSource = readFileSync(join(__dirname, "..", "..", "..", "..", "lib", "dashboard", "axis.ts"), "utf8")
    expect(axisSource).toContain("Math.round(safeTickNumber(value))")
  })
})

describe("DASH-11 / UX E2 — Δ somente em K2/K3 com cor por favorabilidade", () => {
  it("K1/K4/K5 nunca têm badge, sparkline ou seta", () => {
    renderCards()
    for (const label of [
      i18n.t("dashboard.liquidity"),
      i18n.t("dashboard.openInvoices"),
      i18n.t("dashboard.projectedBalance"),
    ]) {
      const card = cardFor(label)
      expect(card.querySelector('[data-slot="kpi-delta"]')).toBeNull()
      expect(card.querySelector("svg")).toBeNull()
    }
    expect(screen.getAllByTestId("kpi-delta-chip")).toHaveLength(2)
  })

  it("gasto↑=rose, gasto↓=emerald, receita↑=emerald, receita↓=rose, flat=muted", () => {
    const { unmount } = renderCards()
    const chips = screen.getAllByTestId("kpi-delta-chip")
    expect(chips[0].className).toContain("text-rose-")
    expect(chips[1].className).toContain("text-emerald-")
    unmount()

    renderCards({
      kpis: {
        ...KPIS,
        realizedExpenseCents: 200000n,
        realizedIncomeCents: 600000n,
        previousExpenseCents: 310000n,
        previousIncomeCents: 750000n,
      },
    })
    const down = screen.getAllByTestId("kpi-delta-chip")
    expect(down[0].className).toContain("text-emerald-")
    expect(down[1].className).toContain("text-rose-")
  })

  it("flat usa token muted", () => {
    renderCards({ kpis: { ...KPIS, realizedExpenseCents: KPIS.previousExpenseCents } })
    const chips = screen.getAllByTestId("kpi-delta-chip")
    expect(chips[0].className).toContain("text-muted-foreground")
  })

  it("mtd_previous.k2/k3 = 0 suprime o badge", () => {
    renderCards({
      kpis: {
        ...KPIS,
        previousExpenseCents: 0n,
        previousIncomeCents: 0n,
      },
    })
    expect(screen.queryByTestId("kpi-delta-chip")).toBeNull()
  })
})

describe("DASH-11 / UX E5 — estados de erro, vazio e carregamento", () => {
  it("erro usa dashboard.loadError e botão dashboard.retry com alvo ≥44px", () => {
    const onRetry = vi.fn()
    renderCards({ error: true, onRetry })
    expect(screen.getByText(i18n.t("dashboard.loadError"))).toBeTruthy()
    const retry = screen.getByRole("button", { name: i18n.t("dashboard.retry") })
    expect(retry.className).toMatch(/min-h-11/)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("vazio por ausência de linhas mostra emptyPremium global único", () => {
    const { container } = renderCharts({ hasAnyData: false, series: [], topCategories: [] })
    expect(screen.getByText(i18n.t("dashboard.emptyPremium"))).toBeTruthy()
    expect(screen.queryByText(i18n.t("dashboard.curveEmpty"))).toBeNull()
    expect(screen.queryByText(i18n.t("dashboard.topEmpty"))).toBeNull()
    expect(container.querySelector('[data-slot="curve-panel"]')).toBeNull()
    expect(container.querySelector('[data-slot="top-panel"]')).toBeNull()
  })

  it("curveEmpty/topEmpty só aparecem quando há dados no painel", () => {
    renderCharts({ series: [], topCategories: [] })
    expect(screen.getByText(i18n.t("dashboard.curveEmpty"))).toBeTruthy()
    expect(screen.getByText(i18n.t("dashboard.topEmpty"))).toBeTruthy()
    expect(screen.queryByText(i18n.t("dashboard.emptyPremium"))).toBeNull()
  })

  it("skeleton reserva altura final, marca aria-busy e respeita reduced motion", () => {
    const { container } = renderCards({ kpis: null, loading: true })
    const grid = container.querySelector('[data-slot="kpi-grid"]')
    expect(grid?.getAttribute("aria-busy")).toBe("true")
    expect(grid?.className).toContain("lg:grid-cols-5")
    expect(container.querySelector(".min-h-36")?.className).toContain("motion-reduce:animate-none")
  })
})
