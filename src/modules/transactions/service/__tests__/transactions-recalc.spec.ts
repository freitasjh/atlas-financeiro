import { beforeEach, describe, expect, it, vi } from 'vitest'

class AccountNegativeBalanceError extends Error {
  constructor() {
    super('account-negative-balance')
    this.name = 'AccountNegativeBalanceError'
  }
}

const sbMocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn() }))
const accMocks = vi.hoisted(() => ({ recalcAccount: vi.fn() }))

vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, auth: { getUser: sbMocks.getUser } },
}))
vi.mock('@/modules/accounts/service/accounts.service', () => ({
  recalcAccount: accMocks.recalcAccount,
  AccountNegativeBalanceError,
}))

const ACC = '11111111-2222-4333-8444-555555555555'
const DEST = '22222222-3333-4333-8444-555555555555'

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1',
    user_id: 'u1',
    account_id: ACC,
    amount_cents: 1000,
    type: 'income',
    description: 'x',
    category_id: null,
    date: '2020-01-01',
    is_transfer: false,
    transfer_destination_account_id: null,
    reconciled: false,
    installment_plan_id: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

beforeEach(() => {
  sbMocks.from.mockReset()
  sbMocks.getUser.mockReset()
  accMocks.recalcAccount.mockReset()
  sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  accMocks.recalcAccount.mockResolvedValue(0)
})

describe('whenCreateTransaction_thenRecalcsAffectedAccounts', () => {
  it('recalcula conta de origem e destino em transferência', async () => {
    sbMocks.from.mockImplementation((table: string) => {
      if (table !== 'transactions') throw new Error(table)
      return {
        insert: () => ({
          select: () => ({
            single: async () => ({ data: baseRow({ is_transfer: true, transfer_destination_account_id: DEST }), error: null }),
          }),
        }),
        delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }
    })
    const { createTransaction } = await import('@/modules/transactions/service/transactions.service')
    await createTransaction({
      account_id: ACC,
      amount_cents: 1000,
      type: 'income',
      description: 'x',
      date: '2020-01-01',
      is_transfer: true,
      transfer_destination_account_id: DEST,
    })
    expect(accMocks.recalcAccount).toHaveBeenCalledWith(ACC)
    expect(accMocks.recalcAccount).toHaveBeenCalledWith(DEST)
  })
})

describe('whenDeleteTransaction_thenRecalcsAffectedAccounts', () => {
  it('busca lançamento antes de excluir e recalcula', async () => {
    sbMocks.from.mockImplementation((table: string) => {
      if (table !== 'transactions') throw new Error(table)
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: baseRow(), error: null }),
            }),
          }),
        }),
        delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }
    })
    const { deleteTransaction } = await import('@/modules/transactions/service/transactions.service')
    await deleteTransaction('t1')
    expect(accMocks.recalcAccount).toHaveBeenCalledWith(ACC)
  })
})

describe('whenRecalcFails_thenThrowsAccountNegativeBalanceError', () => {
  it('create lança e faz rollback', async () => {
    accMocks.recalcAccount.mockRejectedValueOnce(new AccountNegativeBalanceError())
    sbMocks.from.mockImplementation((table: string) => {
      if (table !== 'transactions') throw new Error(table)
      return {
        insert: () => ({
          select: () => ({
            single: async () => ({ data: baseRow(), error: null }),
          }),
        }),
        delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }
    })
    const { createTransaction, AccountNegativeBalanceError: Err } = await import('@/modules/transactions/service/transactions.service')
    await expect(
      createTransaction({ account_id: ACC, amount_cents: 1000, type: 'income', description: 'x', date: '2020-01-01' }),
    ).rejects.toBeInstanceOf(Err)
  })
})

describe('whenUpdateTransaction_thenRecalcsAffectedAccounts', () => {
  it('recalcula conta afetada na edição', async () => {
    sbMocks.from.mockImplementation((table: string) => {
      if (table !== 'transactions') throw new Error(table)
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: baseRow(), error: null }),
            }),
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: async () => ({ data: baseRow({ amount_cents: 2000 }), error: null }),
              }),
            }),
          }),
        }),
      }
    })
    const { updateTransaction } = await import('@/modules/transactions/service/transactions.service')
    await updateTransaction('t1', { amount_cents: 2000 })
    expect(accMocks.recalcAccount).toHaveBeenCalledWith(ACC)
  })
})

describe('whenSetTransactionReconciled_thenRecalcsWhenChanged', () => {
  it('recalcula conta quando reconciled muda', async () => {
    sbMocks.from.mockImplementation((table: string) => {
      if (table !== 'transactions') throw new Error(table)
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: baseRow({ reconciled: false }), error: null }),
            }),
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: async () => ({ error: null }),
          }),
        }),
      }
    })
    const { setTransactionReconciled } = await import('@/modules/transactions/service/transactions.service')
    await setTransactionReconciled('t1', true)
    expect(accMocks.recalcAccount).toHaveBeenCalledWith(ACC)
  })
})

describe('whenUpdateRecalcFails_thenThrowsAndRollsBack', () => {
  it('bloqueia edição por saldo negativo', async () => {
    accMocks.recalcAccount.mockRejectedValueOnce(new AccountNegativeBalanceError())
    sbMocks.from.mockImplementation((table: string) => {
      if (table !== 'transactions') throw new Error(table)
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: baseRow(), error: null }),
            }),
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: async () => ({ data: baseRow({ amount_cents: 2000 }), error: null }),
              }),
            }),
          }),
        }),
      }
    })
    const { updateTransaction, AccountNegativeBalanceError: Err } = await import('@/modules/transactions/service/transactions.service')
    await expect(updateTransaction('t1', { amount_cents: 2000 })).rejects.toBeInstanceOf(Err)
  })
})

describe('whenFetchFails_thenThrows', () => {
  it('delete propaga erro do fetch anterior', async () => {
    sbMocks.from.mockImplementation((table: string) => {
      if (table !== 'transactions') throw new Error(table)
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: new Error('boom') }),
            }),
          }),
        }),
        delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }
    })
    const { deleteTransaction } = await import('@/modules/transactions/service/transactions.service')
    await expect(deleteTransaction('t1')).rejects.toThrow('boom')
  })

  it('setTransactionReconciled propaga erro do fetch anterior', async () => {
    sbMocks.from.mockImplementation((table: string) => {
      if (table !== 'transactions') throw new Error(table)
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: new Error('boom2') }),
            }),
          }),
        }),
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }
    })
    const { setTransactionReconciled } = await import('@/modules/transactions/service/transactions.service')
    await expect(setTransactionReconciled('t1', true)).rejects.toThrow('boom2')
  })
})