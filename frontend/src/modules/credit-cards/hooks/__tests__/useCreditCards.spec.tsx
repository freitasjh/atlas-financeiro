// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCreditCards } from '../useCreditCards'
import { useCreditCardsStore } from '../../store/credit-cards.store'
import type { InvoiceRow } from '../../service/credit-cards.service'

// C1.3/C1.4 — hook: seleção cartão/mês, filtros, contadores, veredito (TDD).
// Batch 2 — '' é seleção válida: modo consolidado agrega faturas de todos.

function seed() {
  useCreditCardsStore.setState({
    cards: [
      {
        id: 'c1',
        user_id: 'u1',
        account_id: 'acc-1',
        tenant_id: null,
        name: 'Cartão A',
        limit_cents: 500000,
        closing_day: 10,
        due_day: 17,
        created_at: '',
        updated_at: '',
        last4: null,
        holder_name: null,
        expiry_mm_aa: null,
        theme: 'platinum',
        is_default: false,
      },
      {
        id: 'c2',
        user_id: 'u1',
        account_id: 'acc-2',
        tenant_id: null,
        name: 'Cartão B',
        limit_cents: 200000,
        closing_day: 5,
        due_day: 12,
        created_at: '',
        updated_at: '',
        last4: null,
        holder_name: null,
        expiry_mm_aa: null,
        theme: 'platinum',
        is_default: false,
      },
    ],
    invoicesByCard: {
      c1: [
        {
          id: 'i1',
          user_id: 'u1',
          credit_card_id: 'c1',
          period_start: '2026-10-11',
          period_end: '2026-11-10',
          due_date: '2026-11-17',
          status: 'closed',
          total_cents: 10000,
          paid_cents: 0,
          paid_at: null,
          created_at: '',
        },
        {
          id: 'i2',
          user_id: 'u1',
          credit_card_id: 'c1',
          period_start: '2026-11-11',
          period_end: '2026-12-10',
          due_date: '2026-12-17',
          status: 'open',
          total_cents: 4000,
          paid_cents: 0,
          paid_at: null,
          created_at: '',
        },
      ],
      c2: [
        {
          id: 'i3',
          user_id: 'u1',
          credit_card_id: 'c2',
          period_start: '2026-11-11',
          period_end: '2026-12-10',
          due_date: '2026-12-12',
          status: 'open',
          total_cents: 6000,
          paid_cents: 0,
          paid_at: null,
          created_at: '',
        },
      ],
    },
    selectedCardId: '',
    status: 'ready',
    invoicesStatus: 'ready',
    error: null,
  })
}

beforeEach(seed)

describe('whenNoCardSelected_thenConsolidatedModeAggregatesAllCards', () => {
  it("'' é seleção válida: sem fallback para o primeiro cartão", () => {
    const { result } = renderHook(() => useCreditCards())
    expect(result.current.selectedCardId).toBe('')
    expect(result.current.isConsolidated).toBe(true)
    expect(result.current.selectedCard).toBeNull()
  })

  it('faturas agregadas de todos os cartões, mais recente primeiro', () => {
    const { result } = renderHook(() => useCreditCards())
    expect(result.current.invoices.map((i) => i.id).sort()).toEqual(['i1', 'i2', 'i3'])
    expect(result.current.periodCodes).toEqual(['2026-11', '2026-10'])
  })

  it('período agrega ids de faturas de todos os cartões do ciclo', () => {
    const { result } = renderHook(() => useCreditCards())
    expect(result.current.periodCode).toBe('2026-11')
    expect([...result.current.periodInvoiceIds].sort()).toEqual(['i2', 'i3'])
  })

  it('veredito consolidado soma limites e devedor de todos', () => {
    const { result } = renderHook(() => useCreditCards())
    expect(result.current.verdict.totalLimitCents).toBe(700000)
    expect(result.current.verdict.totalOutstandingCents).toBe(20000)
    expect(Number.isInteger(result.current.verdict.totalOutstandingCents)).toBe(true)
  })
})

describe('whenCardSelected_thenScopeIsSingleCard', () => {
  it('trocar de cartão restringe faturas e período a ele', () => {
    const { result } = renderHook(() => useCreditCards())
    act(() => result.current.setSelectedCardId('c2'))
    expect(result.current.selectedCardId).toBe('c2')
    expect(result.current.isConsolidated).toBe(false)
    expect(result.current.invoices.map((i) => i.id)).toEqual(['i3'])
    expect(result.current.selectedInvoice?.id).toBe('i3')
    expect([...result.current.periodInvoiceIds]).toEqual(['i3'])
  })

  it('voltar para consolidado reagrega tudo', () => {
    const { result } = renderHook(() => useCreditCards())
    act(() => result.current.setSelectedCardId('c2'))
    act(() => result.current.setSelectedCardId(''))
    expect(result.current.selectedCardId).toBe('')
    expect(result.current.invoices).toHaveLength(3)
  })
})

describe('whenHookDerives_thenCountersAndVerdictAreInCents', () => {
  it('contadores por status + devedor total (paid fora)', () => {
    const { result } = renderHook(() => useCreditCards())
    expect(result.current.counters).toMatchObject({
      openCount: 2,
      closedCount: 1,
      partialCount: 0,
      paidCount: 0,
    })
    expect(result.current.verdict.totalLimitCents).toBe(700000)
    expect(result.current.verdict.totalOutstandingCents).toBe(20000)
    expect(Number.isInteger(result.current.verdict.totalOutstandingCents)).toBe(true)
  })

  it('filtro de despesas alterna sem tocar nos contadores globais', () => {
    const { result } = renderHook(() => useCreditCards())
    expect(result.current.expenseFilter).toBe('all')
    act(() => result.current.setExpenseFilter('pending'))
    expect(result.current.expenseFilter).toBe('pending')
    expect(result.current.counters.openCount).toBe(2)
  })

  it('período explícito seleciona as faturas do ciclo', () => {
    const { result } = renderHook(() => useCreditCards())
    expect(result.current.periodCodes).toEqual(['2026-11', '2026-10'])
    act(() => result.current.setPeriodCode('2026-10'))
    expect(result.current.selectedInvoice?.id).toBe('i1')
    expect([...result.current.periodInvoiceIds]).toEqual(['i1'])
  })
})

function makeInvoice(
  id: string,
  periodStart: string,
  status: InvoiceRow['status'],
  overrides: Partial<InvoiceRow> = {},
): InvoiceRow {
  return {
    id,
    user_id: 'u1',
    credit_card_id: 'c1',
    period_start: periodStart,
    period_end: `${periodStart.slice(0, 7)}-28`,
    due_date: '2027-01-17',
    status,
    total_cents: 10000,
    paid_cents: status === 'paid' ? 10000 : 0,
    paid_at: null,
    created_at: '',
    ...overrides,
  }
}

describe('whenOpenPeriodExists_thenPeriodCodesLeadsWithIt', () => {
  it('período futuro mais recente que a fatura aberta: aberta vira o primeiro chip', () => {
    useCreditCardsStore.setState({
      invoicesByCard: {
        c1: [
          makeInvoice('future', '2026-12-01', 'closed'),
          makeInvoice('open', '2026-11-01', 'open'),
          makeInvoice('old', '2026-10-01', 'paid'),
        ],
      },
    })
    const { result } = renderHook(() => useCreditCards())
    expect(result.current.periodCodes).toEqual(['2026-11', '2026-12', '2026-10'])
    expect(result.current.periodCode).toBe('2026-11')
    expect(result.current.selectedInvoice?.id).toBe('open')
  })

  it('consolidado: período é aberto se qualquer fatura dele estiver open/partial', () => {
    useCreditCardsStore.setState({
      invoicesByCard: {
        c1: [
          makeInvoice('f1', '2027-01-01', 'paid'),
          makeInvoice('o1', '2026-12-01', 'paid'),
          makeInvoice('old1', '2026-11-01', 'paid'),
        ],
        c2: [
          makeInvoice('f2', '2027-01-01', 'paid'),
          makeInvoice('o2', '2026-12-01', 'partial'),
          makeInvoice('old2', '2026-11-01', 'paid'),
        ],
      },
    })
    const { result } = renderHook(() => useCreditCards())
    expect(result.current.periodCodes).toEqual(['2026-12', '2027-01', '2026-11'])
    expect([...result.current.periodInvoiceIds].sort()).toEqual(['o1', 'o2'])
  })

  it('sem fatura aberta: ordem decrescente inalterada', () => {
    useCreditCardsStore.setState({
      invoicesByCard: {
        c1: [
          makeInvoice('f', '2026-12-01', 'paid'),
          makeInvoice('c', '2026-11-01', 'closed', { due_date: '2026-10-17' }),
          makeInvoice('o', '2026-10-01', 'paid'),
        ],
      },
    })
    const { result } = renderHook(() => useCreditCards())
    expect(result.current.periodCodes).toEqual(['2026-12', '2026-11', '2026-10'])
  })

  it('múltiplos períodos abertos: o mais recente deles lidera, demais decrescem', () => {
    useCreditCardsStore.setState({
      invoicesByCard: {
        c1: [
          makeInvoice('f', '2026-12-01', 'paid'),
          makeInvoice('a1', '2026-11-01', 'open'),
          makeInvoice('a2', '2026-10-01', 'partial'),
        ],
      },
    })
    const { result } = renderHook(() => useCreditCards())
    expect(result.current.periodCodes).toEqual(['2026-11', '2026-12', '2026-10'])
  })

  it('periodCodes permanece memoizado entre renders sem mudança de faturas', () => {
    const { result, rerender } = renderHook(() => useCreditCards())
    const first = result.current.periodCodes
    rerender()
    expect(result.current.periodCodes).toBe(first)
  })
})
