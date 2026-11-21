import type { DashboardTransaction } from "./types"
import { toCents } from "./types"

export type MonthlySeriesPoint = {
  /** `YYYY-MM` — chave do bucket, também usada no eixo do gráfico. */
  month: string
  income_cents: bigint
  expense_cents: bigint
}

function monthKeyFromDate(value: Date): string {
  const year = value.getUTCFullYear()
  const month = value.getUTCMonth() + 1
  return `${year}-${String(month).padStart(2, "0")}`
}

/**
 * G1 (RF-12): 12 meses terminando no mês de `now`.
 *
 * Uma única passada sobre as transações; acumulador `Map` mutado no lugar —
 * sem `filter` por mês dentro de loop e sem cópia do acumulador por item
 * (ADR §5.5 / alerta O(N²) da MDN). Direção por `transactions.type` (BG-57);
 * transferências fora (RN04); mês sem linha permanece com `0n`.
 */
export function buildMonthlySeries(
  transactions: readonly DashboardTransaction[],
  now: Date = new Date(),
): MonthlySeriesPoint[] {
  const [endYear, endMonth] = monthKeyFromDate(now).split("-").map(Number)
  const firstIndex = endYear * 12 + (endMonth - 1) - 11

  const months: string[] = []
  const buckets = new Map<string, { income: bigint; expense: bigint }>()
  for (let step = 0; step < 12; step += 1) {
    const index = firstIndex + step
    const year = Math.floor(index / 12)
    const month = (index % 12) + 1
    const key = `${year}-${String(month).padStart(2, "0")}`
    months.push(key)
    buckets.set(key, { income: 0n, expense: 0n })
  }

  for (const item of transactions) {
    if (item.is_transfer) continue
    if (item.type !== "income" && item.type !== "expense") continue
    const bucket = buckets.get(item.date.slice(0, 7))
    if (!bucket) continue
    const cents = toCents(item.amount_cents, "amount_cents")
    if (item.type === "income") bucket.income += cents
    else bucket.expense += cents
  }

  return months.map((month) => {
    const bucket = buckets.get(month)!
    return { month, income_cents: bucket.income, expense_cents: bucket.expense }
  })
}
