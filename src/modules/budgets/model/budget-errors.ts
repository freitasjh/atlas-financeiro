import { BudgetAlreadyExistsError } from '../service/budgets.service'

// O2 — mapper centralizado de erro de orçamentos (review Batch 1, item 3).
// A tela nunca renderiza o erro cru: só chaves budgets.* traduzidas.

export function mapBudgetError(error: unknown, t: (key: string) => string): string {
  if (error instanceof BudgetAlreadyExistsError) return t('budgets.duplicateError')
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (message.includes('budgets_user_category_month_key') || message.includes('budget-already-exists')) {
    return t('budgets.duplicateError')
  }
  if (message.includes('invalid-month')) return t('budgets.monthError')
  return t('budgets.saveError')
}
