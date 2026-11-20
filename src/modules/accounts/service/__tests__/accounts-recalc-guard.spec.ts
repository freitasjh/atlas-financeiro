import { beforeEach, describe, expect, it, vi } from 'vitest'

// Correção pós-review: update não pode editar a conta quando o saldo
// recalculado ficaria negativo. O abort acontece ANTES da escrita.

const sbMocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, auth: { getUser: sbMocks.getUser } },
}))

const ACCOUNT_ID = '11111111-2222-3333-4444-555555555555'

interface Harness {
  updateCalls: Record<string, unknown>[]
  balanceWrites: Record<string, unknown>[]
  initialBalanceCents: number
  txAmountCents: number
}

function setup(harness: Harness): void {
  sbMocks.from.mockImplementation((table: string) => {
    if (table === 'accounts') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: ACCOUNT_ID, initial_balance_cents: harness.initialBalanceCents },
                error: null,
              }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          if ('current_balance_cents' in patch) {
            harness.balanceWrites.push(patch)
            return { eq: () => ({ eq: async () => ({ error: null }) }) }
          }
          harness.updateCalls.push(patch)
          return {
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: { id: ACCOUNT_ID, name: 'Editada', type: 'checking', current_balance_cents: 0 },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        },
      }
    }
    if (table === 'transactions') {
      return {
        select: () => ({
          eq: () => ({
            or: async () => ({
              data: [
                {
                  account_id: ACCOUNT_ID,
                  amount_cents: harness.txAmountCents,
                  type: 'expense',
                  is_transfer: false,
                  transfer_destination_account_id: null,
                  invoice_id: null,
                  date: '2020-01-01',
                },
              ],
              error: null,
            }),
          }),
        }),
      }
    }
    throw new Error(`tabela inesperada: ${table}`)
  })
}

describe('whenRecalculatedBalanceWouldBeNegative_thenUpdateAbortsBeforeWriting', () => {
  beforeEach(() => {
    sbMocks.from.mockReset()
    sbMocks.getUser.mockReset()
    sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  })

  it('lança AccountNegativeBalanceError e não toca na conta', async () => {
    const harness: Harness = {
      updateCalls: [],
      balanceWrites: [],
      initialBalanceCents: 1000,
      txAmountCents: 5000,
    }
    setup(harness)
    const { AccountNegativeBalanceError, updateAccount } = await import(
      '@/modules/accounts/service/accounts.service'
    )

    await expect(updateAccount(ACCOUNT_ID, { name: 'Editada', type: 'checking' })).rejects.toBeInstanceOf(
      AccountNegativeBalanceError,
    )
    expect(harness.updateCalls).toHaveLength(0)
    expect(harness.balanceWrites).toHaveLength(0)
  })

  it('saldo não-negativo persiste o update e devolve o saldo recalculado', async () => {
    const harness: Harness = {
      updateCalls: [],
      balanceWrites: [],
      initialBalanceCents: 10000,
      txAmountCents: 2500,
    }
    setup(harness)
    const { updateAccount } = await import('@/modules/accounts/service/accounts.service')

    const row = await updateAccount(ACCOUNT_ID, { name: 'Editada', type: 'checking' })

    expect(harness.updateCalls).toEqual([{ name: 'Editada', type: 'checking' }])
    expect(harness.balanceWrites).toEqual([{ current_balance_cents: 7500 }])
    expect(row.current_balance_cents).toBe(7500)
    expect(JSON.stringify(harness.updateCalls)).not.toMatch(/balance/i)
  })
})
