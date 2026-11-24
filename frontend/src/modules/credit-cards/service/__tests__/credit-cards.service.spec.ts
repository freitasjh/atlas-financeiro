import { beforeEach, describe, expect, it, vi } from 'vitest'

// C1.2 — service credit_cards CRUD + invoices leitura + pay_invoice (TDD).

const sbMocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, rpc: sbMocks.rpc, auth: { getUser: sbMocks.getUser } },
}))

function cardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'card-1',
    user_id: 'u1',
    account_id: '11111111-1111-1111-8111-111111111111',
    name: 'Cartão final 1234',
    limit_cents: 500000,
    closing_day: 10,
    due_day: 17,
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

type QueryResult = { data: unknown; error: unknown }

function mockTable(ops: Record<string, (arg?: unknown) => unknown>) {
  sbMocks.from.mockImplementation(() => ops as unknown as never)
}
beforeEach(() => {
  sbMocks.from.mockReset()
  sbMocks.rpc.mockReset()
  sbMocks.getUser.mockReset()
  sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
})

describe('whenCreateCreditCardRuns_thenInsertCarriesOnlyClientColumns', () => {
  it('insert sem brand/total/paid/status; cents inteiro positivo', async () => {
    const inserted: Record<string, unknown>[] = []
    mockTable({
      insert: (payload?: unknown) => {
        inserted.push(payload as Record<string, unknown>)
        return { select: () => ({ single: async () => ({ data: { ...(payload as object), id: 'c1' }, error: null }) }) }
      },
    })
    const { createCreditCard } = await import('../credit-cards.service')
    const row = await createCreditCard({
      name: '  Nu  ',
      brand: 'mastercard',
      account_id: '11111111-1111-1111-8111-111111111111',
      limit_cents: 500000,
      closing_day: 10,
      due_day: 17,
    })
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toEqual({
      user_id: 'u1',
      account_id: '11111111-1111-1111-8111-111111111111',
      name: 'Nu',
      limit_cents: 500000,
      closing_day: 10,
      due_day: 17,
    })
    expect(row.id).toBe('c1')
  })

  it('sem sessão lança unauthenticated antes de validar', async () => {
    sbMocks.getUser.mockResolvedValue({ data: { user: null } })
    const { createCreditCard } = await import('../credit-cards.service')
    await expect(
      createCreditCard({ name: 'X', account_id: '11111111-1111-1111-8111-111111111111', limit_cents: 1, closing_day: 1, due_day: 2 }),
    ).rejects.toThrow('unauthenticated')
  })
})

describe('whenUpdateCreditCardRuns_thenPatchNeverTouchesMoneyColumns', () => {
  it('update escopado por id+user_id sem total/paid/status', async () => {
    const seen: { patch: unknown; eqs: unknown[] } = { patch: null, eqs: [] }
    mockTable({
      update: (patch: unknown) => {
        seen.patch = patch
        const chain = {
          eq: (col: string, val: string) => {
            seen.eqs.push([col, val])
            return { eq: chain.eq, select: () => ({ single: async () => ({ data: cardRow(), error: null }) }) }
          },
        }
        return chain
      },
    })
    const { updateCreditCard } = await import('../credit-cards.service')
    await updateCreditCard('card-1', { name: 'Novo', limit_cents: 700000, closing_day: 5, due_day: 12 })
    expect(seen.patch).toEqual({ name: 'Novo', limit_cents: 700000, closing_day: 5, due_day: 12 })
    expect(seen.eqs).toEqual([
      ['id', 'card-1'],
      ['user_id', 'u1'],
    ])
  })
})

describe('whenDeleteCreditCardRuns_thenHistoryGuardMapsToTypedError', () => {
  function mockDelete(error: QueryResult['error']) {
    sbMocks.from.mockImplementation(() => ({
      delete: () => ({ eq: () => ({ eq: async () => ({ data: null, error }) }) }),
    }))
  }

  it('exclusão limpa retorna void', async () => {
    mockDelete(null)
    const { deleteCreditCard } = await import('../credit-cards.service')
    await expect(deleteCreditCard('card-1')).resolves.toBeUndefined()
  })

  it('card-has-history vira CardHasHistoryError (sem cascade silencioso)', async () => {
    mockDelete({ message: 'card-has-history', code: 'P0001' })
    const { deleteCreditCard, CardHasHistoryError } = await import('../credit-cards.service')
    await expect(deleteCreditCard('card-1')).rejects.toBeInstanceOf(CardHasHistoryError)
  })
})

describe('whenInvoicesAreListed_thenReadIsScopedByCard', () => {
  it('lista faturas do cartão ordenadas por period_start desc', async () => {
    const seen: { order?: unknown; eqs: unknown[] } = { eqs: [] }
    sbMocks.from.mockImplementation((table: string) => {
      expect(table).toBe('invoices')
      return {
        select: () => ({
          eq: (col: string, val: string) => {
            seen.eqs.push([col, val])
            return {
              order: (col2: string, opts: unknown) => {
                seen.order = [col2, opts]
                return Promise.resolve({ data: [], error: null })
              },
            }
          },
        }),
      }
    })
    const { listInvoicesByCard } = await import('../credit-cards.service')
    await expect(listInvoicesByCard('card-1')).resolves.toEqual([])
    expect(seen.eqs).toEqual([['credit_card_id', 'card-1']])
    expect(seen.order).toEqual(['period_start', { ascending: false }])
  })
})

describe('whenPayInvoiceRuns_thenRpcErrorsMapToTypedErrors', () => {
  async function runPay(rpcError: unknown) {
    sbMocks.rpc.mockResolvedValue({ data: rpcError ? null : 'tx-1', error: rpcError })
    const svc = await import('../credit-cards.service')
    return svc.payInvoice({ invoiceId: 'inv-1', accountId: '99999999-9999-4999-8999-999999999999', date: '2026-11-17' })
  }

  it('sucesso retorna o id da transferência (valor calculado no servidor)', async () => {
    sbMocks.from.mockImplementation(() => ({}))
    await expect(runPay(null)).resolves.toBe('tx-1')
    expect(sbMocks.rpc).toHaveBeenCalledWith('pay_invoice', {
      p_invoice: 'inv-1',
      p_account: '99999999-9999-4999-8999-999999999999',
      p_date: '2026-11-17',
    })
  })

  it.each([
    ['invoice-nothing-to-pay', 'InvoiceNothingToPayError'],
    ['invoice-already-paid', 'InvoiceAlreadyPaidError'],
    ['invoice-tenant-mismatch', 'InvoiceTenantMismatchError'],
    ['invoice-paid-locked', 'InvoicePaidLockedError'],
    ['invoice-not-found', 'InvoiceNotFoundError'],
    ['account-not-found', 'AccountNotFoundError'],
  ])('erro %s vira %s', async (code, name) => {
    await expect(runPay({ message: code })).rejects.toMatchObject({ name })
    expect.assertions(1)
  })

  it('erro desconhecido propaga sem mascarar', async () => {
    await expect(runPay({ message: 'connection reset' })).rejects.toMatchObject({
      message: 'connection reset',
    })
  })
})
