// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  budgetSchema,
  budgetUpdateSchema,
  MONTH_RE,
  toMonthFirstDay,
  monthRange,
  type BudgetInput,
} from '../budget'

// O1.1 — model zod: category_id uuid, month YYYY-MM-01 (dia 01), limit_cents int > 0.

describe('whenBudgetInputIsValidated_thenUuidMonthAndPositiveLimitAreRequired', () => {
  it('aceita entrada válida', () => {
    const parsed = budgetSchema.parse({
      category_id: '123e4567-e89b-12d3-a456-426614174000',
      month: '2026-11-01',
      limit_cents: 15000,
    } satisfies BudgetInput)
    expect(parsed.limit_cents).toBe(15000)
  })

  it('recusa category_id não-uuid', () => {
    expect(() =>
      budgetSchema.parse({ category_id: 'abc', month: '2026-11-01', limit_cents: 100 }),
    ).toThrow()
  })

  it('recusa mês fora do dia 01', () => {
    expect(() =>
      budgetSchema.parse({
        category_id: '123e4567-e89b-12d3-a456-426614174000',
        month: '2026-11-15',
        limit_cents: 100,
      }),
    ).toThrow()
  })

  it('recusa mês fora do formato YYYY-MM-01', () => {
    expect(() =>
      budgetSchema.parse({
        category_id: '123e4567-e89b-12d3-a456-426614174000',
        month: '11/2026',
        limit_cents: 100,
      }),
    ).toThrow()
  })

  it('recusa limite zero, negativo ou não-inteiro (sem float p/ dinheiro)', () => {
    const base = {
      category_id: '123e4567-e89b-12d3-a456-426614174000',
      month: '2026-11-01',
    }
    expect(() => budgetSchema.parse({ ...base, limit_cents: 0 })).toThrow()
    expect(() => budgetSchema.parse({ ...base, limit_cents: -1 })).toThrow()
    expect(() => budgetSchema.parse({ ...base, limit_cents: 10.5 })).toThrow()
  })
})

describe('whenBudgetUpdateIsValidated_thenPartialPatchWithSameGuards', () => {
  it('aceita patch parcial de limite', () => {
    expect(budgetUpdateSchema.parse({ limit_cents: 20000 })).toEqual({ limit_cents: 20000 })
  })

  it('recusa limite inválido no patch', () => {
    expect(() => budgetUpdateSchema.parse({ limit_cents: 0 })).toThrow()
    expect(() => budgetUpdateSchema.parse({ limit_cents: 1.99 })).toThrow()
  })

  it('recusa mês dia não-01 no patch', () => {
    expect(() => budgetUpdateSchema.parse({ month: '2026-11-20' })).toThrow()
  })
})

describe('whenMonthHelpersRun_thenFirstDayAndRangeAreDerived', () => {
  it('MONTH_RE só casa YYYY-MM-01', () => {
    expect(MONTH_RE.test('2026-11-01')).toBe(true)
    expect(MONTH_RE.test('2026-11-15')).toBe(false)
    expect(MONTH_RE.test('2026-1-01')).toBe(false)
  })

  it('toMonthFirstDay normaliza Date para YYYY-MM-01', () => {
    expect(toMonthFirstDay(new Date(2026, 10, 15))).toBe('2026-11-01')
    expect(toMonthFirstDay(new Date(2026, 0, 1))).toBe('2026-01-01')
  })

  it('monthRange cobre [mês, próximo mês)', () => {
    expect(monthRange('2026-11-01')).toEqual({ start: '2026-11-01', end: '2026-12-01' })
    expect(monthRange('2026-12-01')).toEqual({ start: '2026-12-01', end: '2027-01-01' })
  })
})
