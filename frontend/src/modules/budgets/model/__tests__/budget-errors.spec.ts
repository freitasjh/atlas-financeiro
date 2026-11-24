// O2 — TDD: mapper centralizado de erro (review Batch 1, item 3).
// Nenhum literal: as mensagens vêm do t() injetado (chaves budgets.*).

import { describe, expect, it } from 'vitest'

import { BudgetAlreadyExistsError } from '../../service/budgets.service'
import { mapBudgetError } from '../budget-errors'

const t = (key: string): string => `t:${key}`

describe('whenBudgetFails_thenMapBudgetErrorTranslatesHonestly', () => {
  it('conflito unique (classe) vira duplicateError', () => {
    expect(mapBudgetError(new BudgetAlreadyExistsError(), t)).toBe('t:budgets.duplicateError')
  })

  it('conflito unique (mensagem crua do banco) vira duplicateError', () => {
    expect(mapBudgetError(new Error('duplicate key budgets_user_category_month_key'), t)).toBe(
      't:budgets.duplicateError',
    )
  })

  it('mês inválido vira monthError', () => {
    expect(mapBudgetError(new Error('invalid-month'), t)).toBe('t:budgets.monthError')
  })

  it('erro desconhecido vira saveError (cru nunca vaza)', () => {
    expect(mapBudgetError(new Error('connection reset'), t)).toBe('t:budgets.saveError')
    expect(mapBudgetError(undefined, t)).toBe('t:budgets.saveError')
  })
})
