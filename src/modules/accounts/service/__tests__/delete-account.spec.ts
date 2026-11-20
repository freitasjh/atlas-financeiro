import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountHasHistoryError, deleteAccount } from '../accounts.service'

// RF03 / P2-saneamento iteração 3 — guard de conta no banco (0016).
// `authenticated` recebe `account-has-history` (cascata orfanaria compras de
// cartão) e o serviço traduz para erro tipado; a UI nunca mostra o cru.

const sbMocks = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, auth: { getUser: vi.fn() } },
}))

function setupDelete(error: { message: string } | null, deleted: string[]): void {
  sbMocks.from.mockImplementation((table: string) => {
    if (table !== 'accounts') throw new Error(`tabela inesperada: ${table}`)
    return {
      delete: () => ({
        eq: async (_column: string, id: string) => {
          if (error) return { error }
          deleted.push(id)
          return { error: null }
        },
      }),
    }
  })
}

describe('whenDatabaseGuardRejectsAccountDelete_thenMappedToAccountHasHistory', () => {
  beforeEach(() => {
    sbMocks.from.mockReset()
  })

  it('account-has-history vira AccountHasHistoryError', async () => {
    setupDelete({ message: 'account-has-history' }, [])

    const promise = deleteAccount('acc-1')

    await expect(promise).rejects.toBeInstanceOf(AccountHasHistoryError)
    await expect(promise).rejects.toMatchObject({ name: 'AccountHasHistoryError' })
  })

  it('card-has-history (cascata) vira AccountHasHistoryError', async () => {
    setupDelete({ message: 'card-has-history' }, [])

    await expect(deleteAccount('acc-1')).rejects.toBeInstanceOf(AccountHasHistoryError)
  })

  it('erro desconhecido é propagado sem virar AccountHasHistoryError', async () => {
    setupDelete({ message: 'permission denied for table accounts' }, [])

    const promise = deleteAccount('acc-1')

    await expect(promise).rejects.toThrow(/permission denied/)
    await expect(promise).rejects.not.toBeInstanceOf(AccountHasHistoryError)
  })
})

describe('whenAccountHasNoHistory_thenDeleteSucceeds', () => {
  beforeEach(() => {
    sbMocks.from.mockReset()
  })

  it('sem erro do banco, o id é apagado e nada é lançado', async () => {
    const deleted: string[] = []
    setupDelete(null, deleted)

    await expect(deleteAccount('acc-1')).resolves.toBeUndefined()
    expect(deleted).toEqual(['acc-1'])
  })
})
