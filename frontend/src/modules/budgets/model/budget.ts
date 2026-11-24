import { z } from 'zod'

// O1.1 — model orçamentos. Dinheiro em BIGINT cents; sem float.
// - category_id uuid; month YYYY-MM-01 (dia 01 — espelha CHECK budgets_month_first_day);
// - limit_cents int > 0 (teto zero não é teto; banco aceita >= 0, UI exige positivo).

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/

export const budgetSchema = z.object({
  category_id: z.string().uuid(),
  month: z.string().regex(MONTH_RE),
  limit_cents: z.number().int().positive(),
})

export type BudgetInput = z.input<typeof budgetSchema>
export type BudgetValidated = z.output<typeof budgetSchema>

export const budgetUpdateSchema = z.object({
  month: z.string().regex(MONTH_RE).optional(),
  limit_cents: z.number().int().positive().optional(),
})

export type BudgetPatchInput = z.infer<typeof budgetUpdateSchema>

/** Normaliza Date para YYYY-MM-01 (mês sempre dia 01). */
export function toMonthFirstDay(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

/** Janela do mês: [start, end) para filtrar transactions.date sem N+1. */
export function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }
  const pad = (n: number): string => String(n).padStart(2, '0')
  return { start: month, end: `${next.y}-${pad(next.m)}-01` }
}
