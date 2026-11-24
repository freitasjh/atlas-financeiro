// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

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

function mockInsertSuccess() {
  const out = txRow({ id: 'out-1', account_id: SRC, type: 'expense' })
  const inn = txRow({ id: 'in-1', account_id: DST, type: 'income' })
  const eqInner = vi.fn(() => Promise.resolve({ error: null }))
  const eqOuter = vi.fn(() => ({ eq: eqInner }))
  sbMocks.from.mockImplementation(() => ({
    insert: () => ({ select: () => Promise.resolve({ data: [out, inn], error: null }) }),
    delete: () => ({ eq: eqOuter }),
  }))
}

describe('whenTransferRecalcFails_thenRollbackRecalcsBothAccounts', () => {
  it('recalcula origem E destino no rollback, sem deixar o destino estagnado', async () => {
    sbMocks.from.mockReset()
    sbMocks.getUser.mockReset()
    accMocks.recalcAccount.mockReset()
    accMocks.computeAccountBalance.mockReset()
    sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    accMocks.computeAccountBalance.mockResolvedValue(10000)
    mockInsertSuccess()
    // O recalc da origem (1ª chamada) estoura; os recalcs do rollback resolvem.
    accMocks.recalcAccount.mockRejectedValueOnce(new AccountNegativeBalanceError())
    accMocks.recalcAccount.mockResolvedValue(0)

    const { executeInternalTransfer } = await import(
      '@/modules/transactions/service/transactions.service'
    )
    await expect(executeInternalTransfer(SRC, DST, 5000, 'Aporte', '2026-11-10')).rejects.toThrow()

    const calls = accMocks.recalcAccount.mock.calls.map((c) => c[0])
    // Tentativa inicial: origem + destino (destino nunca é alcançado pois a origem falha primeiro —
    // o ponto é o rollback). Rollback DEVE recalcular ambas.
    expect(calls.filter((c) => c === SRC).length).toBeGreaterThanOrEqual(2)
    expect(calls.filter((c) => c === DST).length).toBeGreaterThanOrEqual(1)
  })
})
