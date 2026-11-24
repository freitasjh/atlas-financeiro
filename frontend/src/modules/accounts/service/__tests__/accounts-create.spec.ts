import { beforeEach, describe, expect, it, vi } from 'vitest'

// RF-06 / RF-03 — criação de conta com campos do template.
// Prova: institution/agency/account_number/account_digit chegam em snake_case,
// saldo viaja em cents inteiros e a conta principal é promovida por RPC
// transacional (0046) — o insert nunca escreve is_default=true.

const sbMocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, rpc: sbMocks.rpc, auth: { getUser: sbMocks.getUser } },
}))

interface Spies {
  inserted: Record<string, unknown>[]
  promoted: string[]
}

function setupCreate(
  rows: Spies,
  options: { insertError?: unknown; rpcError?: unknown } = {},
): void {
  sbMocks.from.mockImplementation(() => ({
    insert: (payload: Record<string, unknown>) => {
      rows.inserted.push(payload)
      return {
        select: () => ({
          single: async () => ({
            data: options.insertError ? null : { ...payload, id: 'a1' },
            error: options.insertError ?? null,
          }),
        }),
      }
    },
  }))
  sbMocks.rpc.mockImplementation(async (_fn: string, args: { p_account_id: string }) => {
    rows.promoted.push(args.p_account_id)
    return { error: options.rpcError ?? null }
  })
}

describe('whenCreateAccountWithTemplateFields_thenInsertCarriesIdentityInCents', () => {
  beforeEach(() => {
    sbMocks.from.mockReset()
    sbMocks.getUser.mockReset()
    sbMocks.rpc.mockReset()
    sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  })

  it('persiste institution/agency/account_number/account_digit/connection_status', async () => {
    const rows: Spies = { inserted: [], promoted: [] }
    setupCreate(rows)
    const { createAccount } = await import('@/modules/accounts/service/accounts.service')

    await createAccount({
      name: 'Itaú • Operacional',
      type: 'checking',
      initial_balance_cents: 123456,
      institution: 'itau',
      agency: '1234',
      account_number: '56789',
      account_digit: '0',
      is_default: true,
      connection_status: 'connected',
    })

    expect(rows.inserted).toHaveLength(1)
    const payload = rows.inserted[0]
    expect(payload).toMatchObject({
      user_id: 'u1',
      name: 'Itaú • Operacional',
      type: 'checking',
      initial_balance_cents: 123456,
      current_balance_cents: 123456,
      institution: 'itau',
      agency: '1234',
      account_number: '56789',
      account_digit: '0',
      connection_status: 'connected',
    })
    expect(Number.isInteger(payload.initial_balance_cents as number)).toBe(true)
  })

  it('conta principal nasce sem a flag e é promovida por RPC (nunca 2 principais)', async () => {
    const rows: Spies = { inserted: [], promoted: [] }
    setupCreate(rows)
    const { createAccount } = await import('@/modules/accounts/service/accounts.service')

    const row = await createAccount({
      name: 'Nova principal',
      type: 'checking',
      initial_balance_cents: 0,
      is_default: true,
    })

    expect(rows.inserted[0]).toMatchObject({ is_default: false })
    expect(sbMocks.rpc).toHaveBeenCalledWith('set_default_account', { p_account_id: 'a1' })
    expect(rows.promoted).toEqual(['a1'])
    expect(row.is_default).toBe(true)
  })

  it('sem is_default não chama a RPC de promoção', async () => {
    const rows: Spies = { inserted: [], promoted: [] }
    setupCreate(rows)
    const { createAccount } = await import('@/modules/accounts/service/accounts.service')

    await createAccount({
      name: 'Caixa Físico',
      type: 'physical_cash',
      initial_balance_cents: 0,
      institution: 'cash',
      is_default: false,
      connection_status: 'manual',
    })

    expect(rows.inserted[0]).toMatchObject({ is_default: false, connection_status: 'manual' })
    expect(rows.promoted).toEqual([])
  })

  it('recusa saldo inicial fracionário (RN01) sem escrever nada', async () => {
    const rows: Spies = { inserted: [], promoted: [] }
    setupCreate(rows)
    const { createAccount } = await import('@/modules/accounts/service/accounts.service')

    await expect(
      createAccount({
        name: 'Conta inválida',
        type: 'checking',
        initial_balance_cents: 10.5,
      }),
    ).rejects.toThrow()

    expect(rows.inserted).toEqual([])
    expect(rows.promoted).toEqual([])
  })

  it('propaga erro do insert da conta', async () => {
    const rows: Spies = { inserted: [], promoted: [] }
    setupCreate(rows, { insertError: { message: 'ux_accounts_user_default' } })
    const { createAccount } = await import('@/modules/accounts/service/accounts.service')

    await expect(
      createAccount({
        name: 'Nova principal',
        type: 'checking',
        initial_balance_cents: 0,
        is_default: true,
      }),
    ).rejects.toEqual({ message: 'ux_accounts_user_default' })

    expect(rows.promoted).toEqual([])
  })

  it('propaga erro da RPC de promoção (preferência não fica silenciosamente perdida)', async () => {
    const rows: Spies = { inserted: [], promoted: [] }
    setupCreate(rows, { rpcError: { message: 'account-not-found' } })
    const { createAccount } = await import('@/modules/accounts/service/accounts.service')

    await expect(
      createAccount({
        name: 'Nova principal',
        type: 'checking',
        initial_balance_cents: 0,
        is_default: true,
      }),
    ).rejects.toEqual({ message: 'account-not-found' })
  })
})
