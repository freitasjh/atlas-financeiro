// @vitest-environment node
import { describe, expect, it } from "vitest"

import { buildTopCategories } from "../top-categories"
import type { DashboardTransaction } from "../types"

const MONTH = "2026-11"
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

describe("buildTopCategories (DASH-10 / RF-13)", () => {
  it("soma o mês corrente por category_id e ordena por total desc em cêntimos", () => {
    const result = buildTopCategories(
      [
        tx({ category_id: "cat-a", amount_cents: 1200 }),
        tx({ category_id: "cat-b", amount_cents: 3500 }),
        tx({ category_id: "cat-a", amount_cents: 800 }),
        tx({ category_id: "cat-c", amount_cents: 2000 }),
      ],
      MONTH,
      3,
    )

    expect(result).toEqual([
      { category_id: "cat-b", total_cents: 3500n },
      { category_id: "cat-a", total_cents: 2000n },
      { category_id: "cat-c", total_cents: 2000n },
    ])
  })

  it("exclui transferências (RN04) e receitas — direção por transactions.type", () => {
    const result = buildTopCategories(
      [
        tx({ category_id: "cat-a", amount_cents: 1000, is_transfer: true }),
        tx({ category_id: "cat-b", amount_cents: 2000, type: "income" }),
        tx({ category_id: "cat-c", amount_cents: 300 }),
      ],
      NOW,
      5,
    )

    expect(result).toEqual([{ category_id: "cat-c", total_cents: 300n }])
  })

  it("agrupa category_id nulo em bucket explícito e ignora mês anterior", () => {
    const result = buildTopCategories(
      [
        tx({ category_id: null, amount_cents: 1500 }),
        tx({ category_id: null, amount_cents: 500 }),
        tx({ category_id: "cat-old", amount_cents: 99999, date: "2026-10-31" }),
      ],
      MONTH,
      5,
    )

    expect(result).toEqual([{ category_id: null, total_cents: 2000n }])
  })

  it("respeita topN", () => {
    const result = buildTopCategories(
      [
        tx({ category_id: "cat-a", amount_cents: 100 }),
        tx({ category_id: "cat-b", amount_cents: 300 }),
        tx({ category_id: "cat-c", amount_cents: 200 }),
      ],
      MONTH,
      2,
    )

    expect(result).toHaveLength(2)
    expect(result.map((item) => item.category_id)).toEqual(["cat-b", "cat-c"])
  })

  it("faz uma única passada indexada (sem filter/map/reduce)", () => {
    const transactions = [
      tx({ category_id: "cat-a", amount_cents: 100 }),
      tx({ category_id: "cat-b", amount_cents: 200 }),
    ]
    for (const method of ["filter", "map", "reduce", "flatMap", "slice"] as const) {
      Object.assign(transactions, {
        [method]: () => {
          throw new Error(`método proibido na agregação: ${method}`)
        },
      })
    }

    expect(buildTopCategories(transactions, MONTH, 5)).toEqual([
      { category_id: "cat-b", total_cents: 200n },
      { category_id: "cat-a", total_cents: 100n },
    ])
  })

  it("devolve lista vazia quando não há gasto no mês", () => {
    expect(buildTopCategories([], MONTH, 5)).toEqual([])
  })
})
