import { describe, expect, it } from 'vitest'
import {
  addMonthsISO,
  MAX_INSTALLMENTS,
  MIN_INSTALLMENTS,
  splitInstallments,
  sumCents,
} from '../installments'

// RN03 — base = floor(V/N), resto na 1ª. Só BIGINT cents (nunca float).

describe('whenSplittingEvenly_thenRemainderGoesToFirst', () => {
  it('100000/3 → [33334, 33333, 33333], soma == total', () => {
    const schedule = splitInstallments(100000, 3)
    expect(schedule).toEqual([33334, 33333, 33333])
    expect(sumCents(schedule)).toBe(100000)
  })

  it('10001/2 → [5001, 5000]', () => {
    expect(splitInstallments(10001, 2)).toEqual([5001, 5000])
  })

  it('total 0 e limites 2..24', () => {
    expect(splitInstallments(0, MIN_INSTALLMENTS)).toEqual([0, 0])
    expect(splitInstallments(25, MAX_INSTALLMENTS)).toHaveLength(24)
  })
})

describe('whenSplitInputInvalid_thenRejects', () => {
  it('float, negativo, count fora de 2..24', () => {
    expect(() => splitInstallments(10.5, 3)).toThrow()
    expect(() => splitInstallments(-1, 3)).toThrow()
    expect(() => splitInstallments(100, 1)).toThrow()
    expect(() => splitInstallments(100, 25)).toThrow()
  })
})

describe('whenAddingMonths_thenClampsEndOfMonth', () => {
  it('31/01/2026 + 1 mês → 28/02/2026', () => {
    expect(addMonthsISO('2026-01-31', 1)).toBe('2026-02-28')
  })

  it('31/01/2024 + 1 mês → 29/02/2024 (bissexto)', () => {
    expect(addMonthsISO('2024-01-31', 1)).toBe('2024-02-29')
  })

  it('15/12/2026 + 2 meses → 15/02/2027', () => {
    expect(addMonthsISO('2026-12-15', 2)).toBe('2027-02-15')
  })
})
