// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

class AccountNegativeBalanceError extends Error {
  constructor() {
    super('account-negative-balance')
    this.name = 'AccountNegativeBalanceError'
  }
}

const sbMocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn() }))
const accMocks = vi.hoisted(() => ({
  recalcAccount: vi.fn(),
  computeAccountBalance: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, auth: { getUser: sbMocks.getUser } },
}))
vi.mock('@/modules/accounts/service/accounts.service', () => ({
  recalcAccount: accMocks.recalcAccount,
  computeAccountBalance: accMocks.computeAccountBalance,
  AccountNegativeBalanceError,
}))

const SRC = '11111111-2222-4333-8444-555555555555'
const DST = '22222222-3333-4333-8444-555555555555'

function txRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tx-id',
    user_id: 'u1',
    account_id: SRC,
    amount_cents: 5000,
    type: 'expense',
    description: 'Transferência interna',
    category_id: null,
    date: '2026-11-10',
    is_transfer: false,
    transfer_destination_account_id: null,
    reconciled: true,
    split_group_id: 'split-1',
    installment_plan_id: null,
    invoice_id: null,
    fitid: null,
    dedup_hash: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

beforeEach(() => {
  sbMocks.from.mockReset()
  sbMocks.getUser.mockReset()
  accMocks.recalcAccount.mockReset()
  accMocks.computeAccountBalance.mockReset()
  sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  accMocks.computeAccountBalance.mockResolvedValue(10000)
  accMocks.recalcAccount.mockResolvedValue(0)
})

describe('whenExecuteInternalTransfer_thenCreatesTwoLinkedEntries', () => {
  it('cria saída na origem + entrada no destino com mesmo split_group_id', async () => {
    const out = txRow({ id: 'out-1', account_id: SRC, type: 'expense' })
    const inn = txRow({ id: 'in-1', account_id: DST, type: 'income' })
    let captured: unknown = null
    sbMocks.from.mockImplementation((table: string) => {
      if (table !== 'transactions') throw new Error(table)
      return {
        insert: (payload: unknown) => {
          captured = payload
          return { select: () => Promise.resolve({ data: [out, inn], error: null }) }
        },
      }
    })
    const { executeInternalTransfer } = await import('@/modules/transactions/service/transactions.service')
    const result = await executeInternalTransfer(SRC, DST, 5000, 'Aporte', '2026-11-10')

    expect(Array.isArray(captured)).toBe(true)
    const rows = captured as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    // origem: expense reconciliada sem flag de transferência legada
    expect(rows[0].account_id).toBe(SRC)
    expect(rows[0].type).toBe('expense')
    expect(rows[0].reconciled).toBe(true)
    expect(rows[0].is_transfer).toBe(false)
    // destino: income reconciliada
    expect(rows[1].account_id).toBe(DST)
    expect(rows[1].type).toBe('income')
    expect(rows[1].reconciled).toBe(true)
    expect(rows[1].is_transfer).toBe(false)
    // vínculo por split_group_id compartilhado
    expect(rows[0].split_group_id).toBeTruthy()
    expect(rows[0].split_group_id).toBe(rows[1].split_group_id)
    expect(rows[0].amount_cents).toBe(5000)
    expect(rows[1].amount_cents).toBe(5000)
    expect(result.splitGroupId).toBe(rows[0].split_group_id)
  })
})

describe('whenExecuteInternalTransfer_thenRecalcsBothAccounts', () => {
  it('recalcula origem e destino após o insert', async () => {
    const out = txRow({ id: 'out-1', account_id: SRC, type: 'expense' })
    const inn = txRow({ id: 'in-1', account_id: DST, type: 'income' })
    sbMocks.from.mockImplementation(() => ({
      insert: () => ({ select: () => Promise.resolve({ data: [out, inn], error: null }) }),
    }))
    const { executeInternalTransfer } = await import('@/modules/transactions/service/transactions.service')
    await executeInternalTransfer(SRC, DST, 5000, 'Aporte', '2026-11-10')
    expect(accMocks.recalcAccount).toHaveBeenCalledWith(SRC)
    expect(accMocks.recalcAccount).toHaveBeenCalledWith(DST)
  })
})

describe('whenSourceBalanceIsInsufficient_thenTransferIsBlocked', () => {
  it('aborta antes de persistir quando origem ficaria negativa', async () => {
    accMocks.computeAccountBalance.mockResolvedValueOnce(3000)
    const insertSpy = vi.fn()
    sbMocks.from.mockImplementation(() => ({ insert: insertSpy }))
    const { executeInternalTransfer, TransferInsufficientError } = await import(
      '@/modules/transactions/service/transactions.service'
    )
    await expect(executeInternalTransfer(SRC, DST, 5000, 'Aporte', '2026-11-10')).rejects.toBeInstanceOf(
      TransferInsufficientError,
    )
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('faz rollback das 2 linhas quando o recalc estoura o saldo', async () => {
    const out = txRow({ id: 'out-1', account_id: SRC, type: 'expense' })
    const inn = txRow({ id: 'in-1', account_id: DST, type: 'income' })
    const delEq = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }))
    sbMocks.from.mockImplementation(() => ({
      insert: () => ({ select: () => Promise.resolve({ data: [out, inn], error: null }) }),
      delete: () => ({ eq: delEq }),
    }))
    accMocks.recalcAccount.mockRejectedValueOnce(new AccountNegativeBalanceError())
    const { executeInternalTransfer, TransferInsufficientError } = await import(
      '@/modules/transactions/service/transactions.service'
    )
    await expect(executeInternalTransfer(SRC, DST, 5000, 'Aporte', '2026-11-10')).rejects.toBeInstanceOf(
      TransferInsufficientError,
    )
    expect(delEq).toHaveBeenCalled()
  })
})

describe('whenTransferParamsAreInvalid_thenThrowsBeforePersist', () => {
  it('rejeita mesma conta e valor zerado', async () => {
    const insertSpy = vi.fn()
    sbMocks.from.mockImplementation(() => ({ insert: insertSpy }))
    const { executeInternalTransfer } = await import('@/modules/transactions/service/transactions.service')
    await expect(executeInternalTransfer(SRC, SRC, 100, 'x', '2026-11-10')).rejects.toThrow()
    await expect(executeInternalTransfer(SRC, DST, 0, 'x', '2026-11-10')).rejects.toThrow()
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
