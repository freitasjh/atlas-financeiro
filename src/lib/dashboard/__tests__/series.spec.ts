// @vitest-environment node
import { describe, expect, it } from "vitest"

import { buildMonthlySeries } from "../series"
import type { DashboardTransaction } from "../types"

const NOW = new Date("2026-11-21T12:00:00.000Z")

function tx(partial: Partial<DashboardTransaction> = {}): DashboardTransaction {
  return {
    date: "2026-11-05",
    amount_cents: 1000,
    type: "expense",
    is_transfer: false,
    category_id: "cat-a",
    ...partial,
  }
}

describe("buildMonthlySeries (DASH-09 / RF-12)", () => {
  it("devolve 12 meses terminando no mês corrente, com somas por type em cêntimos", () => {
    const transactions = [
      tx({ date: "2025-11-10", amount_cents: 99000 }), // fora da janela
      tx({ date: "2025-12-02", amount_cents: 12000, type: "income" }),
      tx({ date: "2025-12-20", amount_cents: 3000 }),
      tx({ date: "2026-11-01", amount_cents: 8000, type: "income" }),
      tx({ date: "2026-11-21", amount_cents: 2500 }),
    ]

    const series = buildMonthlySeries(transactions, NOW)

    expect(series).toHaveLength(12)
    expect(series[0].month).toBe("2025-12")
    expect(series[11].month).toBe("2026-11")
    expect(series[0]).toEqual({
      month: "2025-12",
      income_cents: 12000n,
      expense_cents: 3000n,
    })
    expect(series[11]).toEqual({
      month: "2026-11",
      income_cents: 8000n,
      expense_cents: 2500n,
    })
  })

  it("ignora transferências (RN04) em income e expense", () => {
    const series = buildMonthlySeries(
      [
        tx({ date: "2026-11-03", amount_cents: 50000, is_transfer: true }),
        tx({ date: "2026-11-04", amount_cents: 700, type: "income", is_transfer: true }),
        tx({ date: "2026-11-05", amount_cents: 400 }),
      ],
      NOW,
    )

    expect(series[11]).toEqual({
      month: "2026-11",
      income_cents: 0n,
      expense_cents: 400n,
    })
  })

  it("direção vem de type: categoria nula com type=income entra como income (BG-57)", () => {
    const series = buildMonthlySeries(
      [tx({ date: "2026-11-06", amount_cents: 999, type: "income", category_id: null })],
      NOW,
    )

    expect(series[11].income_cents).toBe(999n)
    expect(series[11].expense_cents).toBe(0n)
  })

  it("mês sem transação aparece com zero (não é omitido)", () => {
    const series = buildMonthlySeries([tx({ date: "2026-11-06" })], NOW)

    expect(series).toHaveLength(12)
    for (const point of series.slice(0, 11)) {
      expect(point.income_cents).toBe(0n)
      expect(point.expense_cents).toBe(0n)
    }
  })

  it("faz uma única passada: não usa filter/map/reduce nem copia o acumulador por item", () => {
    const transactions = [
      tx({ date: "2026-10-01", amount_cents: 100 }),
      tx({ date: "2026-11-01", amount_cents: 200 }),
      tx({ date: "2026-11-02", amount_cents: 300, type: "income" }),
    ]
    for (const method of ["filter", "map", "reduce", "flatMap", "slice"] as const) {
      Object.assign(transactions, {
        [method]: () => {
          throw new Error(`método proibido na agregação: ${method}`)
        },
      })
    }

    const series = buildMonthlySeries(transactions, NOW)

    expect(series[10].expense_cents).toBe(100n)
    expect(series[11].expense_cents).toBe(200n)
    expect(series[11].income_cents).toBe(300n)
  })

  it("aceita amount_cents bigint sem perder precisão", () => {
    const series = buildMonthlySeries(
      [tx({ date: "2026-11-01", amount_cents: 9007199254740993n })],
      NOW,
    )

    expect(series[11].expense_cents).toBe(9007199254740993n)
  })

  it("descarta type desconhecido em vez de inferir direção pela categoria", () => {
    const series = buildMonthlySeries(
      [tx({ date: "2026-11-01", amount_cents: 1234, type: "refund" as never })],
      NOW,
    )

    expect(series[11].income_cents).toBe(0n)
    expect(series[11].expense_cents).toBe(0n)
  })
})
