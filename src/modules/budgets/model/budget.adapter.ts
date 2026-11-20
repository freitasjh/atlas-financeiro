import type { Database } from '@/types/supabase'

export type BudgetRow = Database['public']['Tables']['budgets']['Row']

/** Linha mínima para o adapter (testável sem o schema gerado). */
export interface BudgetRowLike {
  id: string
  user_id: string
  category_id: string
  month: string
  limit_cents: number
}

export type BudgetStatus = 'ok' | 'warning' | 'over'

/** Contrato de UI: teto + gasto agregado do mês + semáforo derivado. */
export interface BudgetView {
  id: string
  categoryId: string
  categoryName?: string
  month: string
  limitCents: number
  spentCents: number
  status: BudgetStatus
}

/**
 * Semáforo: ok | warning (>=80%) | over (>100%).
 * Aritmética inteira (spent*100 vs limit*80) — sem float p/ dinheiro.
 */
export function budgetStatus(spentCents: number, limitCents: number): BudgetStatus {
  // Guarda display: teto não-positivo nunca existiu na criação (zod
  // positive), mas dado legado/zerado não pode gerar warning/over fantasma.
  if (limitCents <= 0) return 'ok'
  if (spentCents > limitCents) return 'over'
  if (spentCents * 100 >= limitCents * 80) return 'warning'
  return 'ok'
}

export function toBudgetView(row: BudgetRowLike): BudgetView {
  return {
    id: row.id,
    categoryId: row.category_id,
    month: row.month,
    limitCents: row.limit_cents,
    spentCents: 0,
    status: 'ok',
  }
}

export interface SpendingTx {
  category_id?: string | null
  amount_cents: number
}

/** Anexa gasto agregado (Map de 1 query) em passada única — sem N+1. */
export function withSpending(views: BudgetView[], txs: SpendingTx[]): BudgetView[] {
  const totals = new Map<string, number>()
  for (const tx of txs) {
    if (!tx.category_id) continue
    totals.set(tx.category_id, (totals.get(tx.category_id) ?? 0) + tx.amount_cents)
  }
  return views.map((view) => {
    const spentCents = totals.get(view.categoryId) ?? 0
    return { ...view, spentCents, status: budgetStatus(spentCents, view.limitCents) }
  })
}
