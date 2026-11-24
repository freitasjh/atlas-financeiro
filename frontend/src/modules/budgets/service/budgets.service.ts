import { supabase } from '@/lib/supabase'
import type { Database } from '@/types/supabase'
import {
  budgetSchema,
  budgetUpdateSchema,
  monthRange,
  MONTH_RE,
  type BudgetInput,
  type BudgetPatchInput,
} from '../model/budget'

export type BudgetRow = Database['public']['Tables']['budgets']['Row']

/** Conflito unique (user_id, category_id, month) → erro honesto p/ UI. */
export class BudgetAlreadyExistsError extends Error {
  constructor() {
    super('budget-already-exists')
    this.name = 'BudgetAlreadyExistsError'
  }
}

async function requireUserId(): Promise<string> {
  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')
  return userId
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (code === '23505') return true
  const message = (error as { message?: unknown }).message
  return (
    typeof message === 'string' && message.includes('budgets_user_category_month_key')
  )
}

/** Lista tetos do tenant no mês (RLS: auth.uid() = user_id), ordenados por categoria. */
export async function listBudgets(month: string): Promise<BudgetRow[]> {
  if (!MONTH_RE.test(month)) throw new Error('invalid-month')
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('budgets')
    .select('*')
    .eq('user_id', userId)
    .eq('month', month)
    .order('category_id', { ascending: true })
  if (error) throw error
  return (data ?? []) as BudgetRow[]
}

export async function createBudget(input: BudgetInput): Promise<BudgetRow> {
  const userId = await requireUserId()
  const parsed = budgetSchema.parse(input)
  const { data, error } = await supabase
    .from('budgets')
    .insert({
      user_id: userId,
      category_id: parsed.category_id,
      month: parsed.month,
      limit_cents: parsed.limit_cents,
    })
    .select('*')
    .single()
  if (error) {
    if (isUniqueViolation(error)) throw new BudgetAlreadyExistsError()
    throw error
  }
  return data as BudgetRow
}

export async function updateBudget(id: string, patch: BudgetPatchInput): Promise<BudgetRow> {
  const userId = await requireUserId()
  const safe = budgetUpdateSchema.parse(patch)
  const payload: Record<string, unknown> = {}
  if (safe.month !== undefined) payload.month = safe.month
  if (safe.limit_cents !== undefined) payload.limit_cents = safe.limit_cents
  const { data, error } = await supabase
    .from('budgets')
    .update(payload)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) {
    if (isUniqueViolation(error)) throw new BudgetAlreadyExistsError()
    throw error
  }
  return data as BudgetRow
}

/**
 * Exclui teto. Sem bloqueio extra: se a categoria for excluída, o banco
 * remove o teto junto (FK budgets.category_id ON DELETE CASCADE) — sem orfão.
 */
export async function deleteBudget(id: string): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase.from('budgets').delete().eq('id', id).eq('user_id', userId)
  if (error) throw error
}

/**
 * Gasto por categoria no mês em 1 query agregável:
 * type='expense' + is_transfer=false + date no mês. Agregação no cliente
 * (Map) — sem N+1 por categoria.
 */
export async function spendingByCategory(month: string): Promise<Map<string, number>> {
  if (!MONTH_RE.test(month)) throw new Error('invalid-month')
  const userId = await requireUserId()
  const { start, end } = monthRange(month)
  const { data, error } = await supabase
    .from('transactions')
    .select('category_id, amount_cents')
    .eq('user_id', userId)
    .eq('type', 'expense')
    .eq('is_transfer', false)
    .gte('date', start)
    .lt('date', end)
  if (error) throw error
  const totals = new Map<string, number>()
  for (const tx of (data ?? []) as Array<{ category_id: string | null; amount_cents: number }>) {
    if (!tx.category_id) continue
    totals.set(tx.category_id, (totals.get(tx.category_id) ?? 0) + tx.amount_cents)
  }
  return totals
}
