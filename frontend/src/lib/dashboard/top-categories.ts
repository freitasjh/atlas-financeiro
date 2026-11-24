import type { DashboardTransaction } from "./types"
import { toCents } from "./types"

export type TopCategory = {
  /** `null` = bucket explícito "sem categoria". */
  category_id: string | null
  total_cents: bigint
}

const UNCATEGORIZED = "\u0000uncategorized"

function monthKey(value: string | Date): string {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`
  }
  return value.slice(0, 7)
}

/**
 * G2 (RF-13 / errata PRD §14): top N de gasto do MÊS CORRENTE.
 *
 * `Map<category_id, bigint>` mutado em uma passada; `type='expense'`,
 * `is_transfer=false`, categoria nula em bucket explícito. Ordem por soma
 * desc; empate quebrado por identificador para saída determinística.
 */
export function buildTopCategories(
  transactions: readonly DashboardTransaction[],
  month: string | Date,
  topN = 5,
): TopCategory[] {
  const target = monthKey(month)
  const totals = new Map<string, bigint>()

  for (const item of transactions) {
    if (item.is_transfer) continue
    if (item.type !== "expense") continue
    if (item.date.slice(0, 7) !== target) continue
    const key = item.category_id ?? UNCATEGORIZED
    const cents = toCents(item.amount_cents, "amount_cents")
    totals.set(key, (totals.get(key) ?? 0n) + cents)
  }

  return [...totals.entries()]
    .map(([key, total_cents]) => ({
      category_id: key === UNCATEGORIZED ? null : key,
      total_cents,
    }))
    .sort((a, b) => {
      if (a.total_cents !== b.total_cents) return a.total_cents > b.total_cents ? -1 : 1
      return String(a.category_id ?? "").localeCompare(String(b.category_id ?? ""))
    })
    .slice(0, topN)
}
