/**
 * Contratos puros do dashboard (ADR-001 §4). Nenhum valor here é formatado:
 * cêntimos trafegam como inteiro/bigint até `formatCents`.
 */

export type DashboardTransaction = {
  date: string
  amount_cents: number | bigint
  /** Direção contábil: `transactions.type` (BG-57). Nunca `categories.type`. */
  type: string
  is_transfer: boolean
  category_id: string | null
}

export type DashboardKpis = {
  month: string
  as_of: string
  k1_liquidity_cents: bigint
  k2_realized_expense_cents: bigint
  k3_realized_income_cents: bigint
  k4_open_invoices_cents: bigint
  k5_projected_balance_cents: bigint
  mtd_current: MtdWindow
  mtd_previous: MtdWindow
}

export type MtdWindow = {
  from: string
  to: string
  k2_realized_expense_cents: bigint
  k3_realized_income_cents: bigint
}

export type DashboardKpiValues = {
  liquidityCents: bigint
  realizedExpenseCents: bigint
  realizedIncomeCents: bigint
  openInvoicesCents: bigint
  projectedBalanceCents: bigint
  previousExpenseCents: bigint
  previousIncomeCents: bigint
}

/** Converte o `*_cents` da RPC sem float. `null`/`undefined` = erro de contrato. */
export function toCents(value: unknown, field: string): bigint {
  if (value === null || value === undefined) {
    throw new TypeError(`dashboard: ${field} não pode ser nulo`)
  }
  if (typeof value === "bigint") return value
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`dashboard: ${field} deve ser inteiro seguro`)
    }
    return BigInt(value)
  }
  throw new TypeError(`dashboard: ${field} deve ser inteiro (cêntimos)`)
}
