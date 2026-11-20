import { beforeEach, describe, expect, it, vi } from 'vitest'

// C1.3 — store zustand: load/create/update/delete + silent (TDD).

const svc = vi.hoisted(() => ({
  listCreditCards: vi.fn(),
  createCreditCard: vi.fn(),
  updateCreditCard: vi.fn(),
  deleteCreditCard: vi.fn(),
  listInvoicesByCard: vi.fn(),
}))
vi.mock('@/modules/credit-cards/service/credit-cards.service', () => svc)

import { useCreditCardsStore } from '../credit-cards.store'

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    user_id: 'u1',
    account_id: '11111111-1111-1111-8111-111111111111',
    tenant_id: null,
    name: 'B Cartão',
    limit_cents: 1000,
    closing_day: 10,
    due_day: 17,
    created_at: '',
    updated_at: '',
    last4: null,
    holder_name: null,
    expiry_mm_aa: null,
    theme: 'platinum',
    is_default: false,
    ...overrides,
  }
}

function reset() {
  useCreditCardsStore.setState({
    cards: [],
    invoicesByCard: {},
    selectedCardId: '',
    status: 'idle',
    invoicesStatus: 'idle',
    error: null,
  })
  svc.listCreditCards.mockReset()
  svc.createCreditCard.mockReset()
  svc.updateCreditCard.mockReset()
  svc.deleteCreditCard.mockReset()
  svc.listInvoicesByCard.mockReset()
}

describe('whenStoreLoads_thenCardsSortByName', () => {
  beforeEach(reset)

  it('load ordena A→Z e marca ready', async () => {
    svc.listCreditCards.mockResolvedValue([card({ id: 'b', name: 'B' }), card({ id: 'a', name: 'A' })])
    await useCreditCardsStore.getState().load()
    const state = useCreditCardsStore.getState()
    expect(state.cards.map((c) => c.id)).toEqual(['a', 'b'])
    expect(state.status).toBe('ready')
    expect(state.error).toBeNull()
  })

  it('load com falha marca error', async () => {
    svc.listCreditCards.mockRejectedValue(new Error('boom'))
    await useCreditCardsStore.getState().load()
    expect(useCreditCardsStore.getState().status).toBe('error')
  })

  it('load silent não troca o status (sem skeleton em refresh)', async () => {
    useCreditCardsStore.setState({ status: 'ready' })
    svc.listCreditCards.mockResolvedValue([])
    await useCreditCardsStore.getState().load({ silent: true })
    expect(useCreditCardsStore.getState().status).toBe('ready')
  })
})

describe('whenStoreMutates_thenLocalStateReconciles', () => {
  beforeEach(reset)

  it('create insere ordenado', async () => {
    useCreditCardsStore.setState({ cards: [card({ id: 'b', name: 'B' })] })
    svc.createCreditCard.mockResolvedValue(card({ id: 'a', name: 'A' }))
    await useCreditCardsStore.getState().create({
      name: 'A',
      account_id: '11111111-1111-1111-8111-111111111111',
      limit_cents: 1,
      closing_day: 1,
      due_day: 2,
    })
    expect(useCreditCardsStore.getState().cards.map((c) => c.name)).toEqual(['A', 'B'])
  })

  it('update troca a linha e remove filtra + limpa cache de faturas', async () => {
    useCreditCardsStore.setState({
      cards: [card({ id: 'a', name: 'A' })],
      invoicesByCard: { a: [], b: [] },
    })
    svc.updateCreditCard.mockResolvedValue(card({ id: 'a', name: 'A2' }))
    await useCreditCardsStore.getState().update('a', {
      name: 'A2',
      limit_cents: 1000,
      closing_day: 10,
      due_day: 17,
    })
    expect(useCreditCardsStore.getState().cards[0].name).toBe('A2')

    svc.deleteCreditCard.mockResolvedValue(undefined)
    await useCreditCardsStore.getState().remove('a')
    const state = useCreditCardsStore.getState()
    expect(state.cards).toHaveLength(0)
    expect(state.invoicesByCard).not.toHaveProperty('a')
  })

  it('falha em remove propaga sem limpar o estado local', async () => {
    useCreditCardsStore.setState({ cards: [card({ id: 'a', name: 'A' })] })
    svc.deleteCreditCard.mockRejectedValue(new Error('card-has-history'))
    await expect(useCreditCardsStore.getState().remove('a')).rejects.toThrow('card-has-history')
    expect(useCreditCardsStore.getState().cards).toHaveLength(1)
  })
})

describe('whenInvoicesLoad_thenCacheIsScopedByCard', () => {
  beforeEach(reset)

  it('loadInvoices guarda por cartão; selectCard só troca a seleção', async () => {
    svc.listInvoicesByCard.mockResolvedValue([])
    await useCreditCardsStore.getState().loadInvoices('c1')
    expect(svc.listInvoicesByCard).toHaveBeenCalledWith('c1')
    expect(useCreditCardsStore.getState().invoicesByCard).toHaveProperty('c1')

    useCreditCardsStore.getState().selectCard('c9')
    expect(useCreditCardsStore.getState().selectedCardId).toBe('c9')
    expect(svc.listInvoicesByCard).toHaveBeenCalledTimes(1)
  })
})
