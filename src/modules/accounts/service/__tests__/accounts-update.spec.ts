import { beforeEach, describe, expect, it, vi } from 'vitest'

// RF-51 nits TDD FIRST — update estreito: patch = Pick<AccountCreate,'name'|'type'>.
// Prova: initial/current_balance nunca chegam ao update do supabase.

const sbMocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, auth: { getUser: sbMocks.getUser } },
}))

describe('whenUpdateAccount_thenSendsOnlyNameAndType', () => {
  beforeEach(() => {
    sbMocks.from.mockReset()
    sbMocks.getUser.mockReset()
    sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  })

  it('nunca encaminha saldo ao update (só name+type)', async () => {
    const { updateAccount } = await import('@/modules/accounts/service/accounts.service')
    let sent: Record<string, unknown> | null = null
    let singleCalls = 0
    sbMocks.from.mockImplementation((table: string) => {
      const chain: Record<string, (...args: unknown[]) => unknown> = {}
      chain.update = (p: unknown) => {
        if (table === 'accounts' && sent === null) sent = p as Record<string, unknown>
        return chain
      }
      chain.eq = () => chain
      chain.select = () => chain
      chain.or = async () => ({ data: [], error: null })
      chain.single = async () => {
        // 1ª leitura: computeAccountBalance (initial); 2ª: linha atualizada pelo update.
        if (singleCalls++ === 0) return { data: { id: 'a1', initial_balance_cents: 10000 }, error: null }
        return { data: { id: 'a1', name: 'Y', type: 'checking', current_balance_cents: 10000 }, error: null }
      }
      return chain
    })
    await updateAccount('11111111-2222-3333-4444-555555555555', {
      name: 'Y',
      type: 'checking',
      initial_balance_cents: 999,
      current_balance_cents: 888,
    } as unknown as { name: string; type: string })
    expect(sent).toEqual({ name: 'Y', type: 'checking' })
    expect(JSON.stringify(sent)).not.toMatch(/balance/i)
  })
})

describe('whenUpdateAccountIncludesTemplateFields_thenForwardsOnlyEditableColumns', () => {
  beforeEach(() => {
    sbMocks.from.mockReset()
    sbMocks.getUser.mockReset()
    sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  })

  it('encaminha institution/agency/account_number/account_digit sem saldo', async () => {
    const { updateAccount } = await import('@/modules/accounts/service/accounts.service')
    let sent: Record<string, unknown> | null = null
    let singleCalls = 0
    sbMocks.from.mockImplementation((table: string) => {
      const chain: Record<string, (...args: unknown[]) => unknown> = {}
      chain.update = (p: unknown) => {
        if (table === 'accounts' && sent === null) sent = p as Record<string, unknown>
        return chain
      }
      chain.eq = () => chain
      chain.select = () => chain
      chain.or = async () => ({ data: [], error: null })
      chain.single = async () => {
        if (singleCalls++ === 0) return { data: { id: 'a1', initial_balance_cents: 10000 }, error: null }
        return { data: { id: 'a1', name: 'Y', type: 'checking', current_balance_cents: 10000 }, error: null }
      }
      return chain
    })

    await updateAccount('11111111-2222-3333-4444-555555555555', {
      name: 'Nubank • Cobranças',
      type: 'checking',
      institution: 'nubank',
      agency: '0001',
      account_number: '9876543',
      account_digit: '2',
    })

    expect(sent).toEqual({
      name: 'Nubank • Cobranças',
      type: 'checking',
      institution: 'nubank',
      agency: '0001',
      account_number: '9876543',
      account_digit: '2',
    })
    expect(JSON.stringify(sent)).not.toMatch(/balance/i)
  })
})

describe('whenUpdateAccountViolatesSchema_thenNoWriteHappens', () => {
  beforeEach(() => {
    sbMocks.from.mockReset()
    sbMocks.getUser.mockReset()
    sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  })

  it('recusa type fora do contrato antes de ler ou escrever no banco', async () => {
    const { updateAccount } = await import('@/modules/accounts/service/accounts.service')

    await expect(
      updateAccount('11111111-2222-3333-4444-555555555555', { name: 'X', type: 'nao-existe' }),
    ).rejects.toThrow()

    expect(sbMocks.from).not.toHaveBeenCalled()
  })
})
