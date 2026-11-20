import { describe, expect, it } from 'vitest'
import { routeInvoice } from '../invoice-routing'

// RN02 — roteamento puro: compra dia >= closing → próximo ciclo.
// Dois cartões com closing_days diferentes, datas iguais, ciclos diferentes.

describe('whenPurchaseBeforeClosing_thenCurrentCycle', () => {
  it('14/04 com closing 15 → ciclo 16/03..15/04, vencimento 22/04', () => {
    expect(routeInvoice('2026-04-14', 15, 22)).toEqual({
      period_start: '2026-03-16',
      period_end: '2026-04-15',
      due_date: '2026-04-22',
    })
  })
})

describe('whenPurchaseOnClosingDay_thenNextCycle', () => {
  it('15/04 com closing 15 → ciclo 16/04..15/05 (fatura de abril intacta)', () => {
    expect(routeInvoice('2026-04-15', 15, 22)).toEqual({
      period_start: '2026-04-16',
      period_end: '2026-05-15',
      due_date: '2026-05-22',
    })
  })
})

describe('whenClosingAndDueDaysDiffer_thenCyclesDiffer', () => {
  it('dois cartões, mesma data: closing 15 fecha abril; closing 5 fecha maio', () => {
    const a = routeInvoice('2026-04-14', 15, 22)
    const b = routeInvoice('2026-04-14', 5, 22)
    expect(a.period_end).toBe('2026-04-15')
    expect(b.period_end).toBe('2026-05-05')
    expect(b.period_start).toBe('2026-04-06')
    expect(a.period_end).not.toBe(b.period_end)
  })
})

describe('whenDayExceedsMonthLength_thenClamp', () => {
  it('closing 31 em fevereiro não-víssexto → 28/02', () => {
    expect(routeInvoice('2026-02-14', 31, 10).period_end).toBe('2026-02-28')
  })

  it('due 31 em abril → 30/04', () => {
    expect(routeInvoice('2026-04-14', 15, 31).due_date).toBe('2026-04-30')
  })

  it('due_day <= closing_day → vencimento no mês seguinte ao fechamento', () => {
    expect(routeInvoice('2026-04-14', 15, 10).due_date).toBe('2026-05-10')
  })
})

describe('whenInputInvalid_thenRejects', () => {
  it('data fora de YYYY-MM-DD e dias fora de 1..31', () => {
    expect(() => routeInvoice('14/04/2026', 15, 22)).toThrow('data deve ser YYYY-MM-DD')
    expect(() => routeInvoice('2026-04-14', 0, 22)).toThrow()
    expect(() => routeInvoice('2026-04-14', 15, 32)).toThrow()
  })
})
