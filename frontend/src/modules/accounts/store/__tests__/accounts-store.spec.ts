import { beforeEach, describe, expect, it, vi } from 'vitest'

const svc = vi.hoisted(() => ({
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  listAccounts: vi.fn(),
}))
vi.mock('@/modules/accounts/service/accounts.service', () => svc)

import { useAccountsStore } from '../accounts.store'
import type { AccountRow } from '../../service/accounts.service'

function row(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'a1',
    user_id: 'u1',
    tenant_id: null,
    name: 'Conta A',
    type: 'checking',
    initial_balance_cents: 1000,
    current_balance_cents: 1000,
    color: null,
    institution: 'itau',
    agency: null,
    account_number: null,
    account_digit: null,
    is_default: false,
    connection_status: 'manual',
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

function reset(): void {
  useAccountsStore.setState({ accounts: [], status: 'ready', error: null })
  svc.createAccount.mockReset()
  svc.updateAccount.mockReset()
  svc.deleteAccount.mockReset()
  svc.listAccounts.mockReset()
}

describe('whenCreateAccountIsDefault_thenLocalPreviousDefaultIsCleared', () => {
  beforeEach(reset)

  it('só a nova conta permanece com is_default', async () => {
    useAccountsStore.setState({ accounts: [row({ id: 'old', name: 'Antiga', is_default: true })] })
    svc.createAccount.mockResolvedValue(row({ id: 'new', name: 'Nova', is_default: true }))

    await useAccountsStore.getState().create({
      name: 'Nova',
      type: 'checking',
      initial_balance_cents: 0,
      is_default: true,
    })

    const accounts = useAccountsStore.getState().accounts
    expect(accounts.filter((a) => a.is_default).map((a) => a.id)).toEqual(['new'])
  })
})

describe('whenUpdateFails_thenStoreReloadsInFinally', () => {
  beforeEach(reset)

  it('reconcilia com o banco mesmo no erro e propaga a falha', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    useAccountsStore.setState({ accounts: [row()], load })
    svc.updateAccount.mockRejectedValue(new Error('account-negative-balance'))

    await expect(
      useAccountsStore.getState().update('a1', { name: 'X', type: 'checking' }),
    ).rejects.toThrow(/account-negative-balance/)

    expect(load).toHaveBeenCalledWith({ silent: true })
  })
})
