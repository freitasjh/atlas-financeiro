// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCreditCards } from '../useCreditCards'
import { useCreditCardsStore } from '../../store/credit-cards.store'

// P3.1 — trocar cartão/mês preserva filtros (TDD: filtro vive no hook,
// seleção de cartão/mês nunca o reseta).

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

describe('whenCardOrMonthChanges_thenExpenseFilterIsPreserved', () => {
  it('trocar de cartão mantém o filtro ativo', () => {
    seed()
    const { result } = renderHook(() => useCreditCards())
    act(() => result.current.setExpenseFilter('pending'))
    expect(result.current.expenseFilter).toBe('pending')

    act(() => result.current.setSelectedCardId('c2'))
    expect(result.current.expenseFilter).toBe('pending')
    expect(result.current.invoices.map((i) => i.id)).toEqual(['i3'])

    act(() => result.current.setSelectedCardId('c1'))
    expect(result.current.expenseFilter).toBe('pending')

    act(() => result.current.setSelectedCardId(''))
    expect(result.current.expenseFilter).toBe('pending')
    expect(result.current.invoices).toHaveLength(3)
  })

  it('trocar de mês mantém o filtro ativo', () => {
    seed()
    const { result } = renderHook(() => useCreditCards())
    act(() => result.current.setExpenseFilter('installments'))
    expect(result.current.periodCode).toBe('2026-11')

    act(() => result.current.setPeriodCode('2026-10'))
    expect(result.current.expenseFilter).toBe('installments')
    expect(result.current.selectedInvoice?.id).toBe('i1')

    act(() => result.current.setPeriodCode('2026-11'))
    expect(result.current.expenseFilter).toBe('installments')
    expect([...result.current.periodInvoiceIds].sort()).toEqual(['i2', 'i3'])
  })

  it('filtro + cartão + mês combinados não derrubam contadores globais', () => {
    seed()
    const { result } = renderHook(() => useCreditCards())
    act(() => result.current.setExpenseFilter('pending'))
    act(() => result.current.setSelectedCardId('c1'))
    act(() => result.current.setPeriodCode('2026-10'))

    expect(result.current.expenseFilter).toBe('pending')
    expect(result.current.selectedInvoice?.id).toBe('i1')
    expect(result.current.counters).toMatchObject({ openCount: 1, closedCount: 1 })
    expect(Number.isInteger(result.current.verdict.totalOutstandingCents)).toBe(true)
  })
})
