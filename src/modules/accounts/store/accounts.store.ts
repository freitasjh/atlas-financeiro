import { create } from 'zustand'
import {
  createAccount,
  deleteAccount,
  listAccounts,
  updateAccount,
  type AccountCreate,
  type AccountRow,
  type AccountUpdate,
} from '../service/accounts.service'

// FE-20 — store contas (zustand). Saldo exibido = current_balance_cents
// (cache recalculado); formulário nunca edita saldo.

interface LoadOptions {
  // `silent` não troca o status (evita skeleton em refresh pós-mutação).
  silent?: boolean
}

interface AccountsState {
  accounts: AccountRow[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  load: (options?: LoadOptions) => Promise<void>
  create: (input: AccountCreate) => Promise<AccountRow>
  update: (id: string, patch: AccountUpdate) => Promise<AccountRow>
  remove: (id: string) => Promise<void>
}

function byName(a: AccountRow, b: AccountRow): number {
  return a.name.localeCompare(b.name)
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  status: 'idle',
  error: null,
  async load(options) {
    if (!options?.silent) set({ status: 'loading', error: null })
    try {
      const accounts = await listAccounts()
      set({ accounts, status: 'ready', error: null })
    } catch (e) {
      set({ status: options?.silent ? get().status : 'error', error: e instanceof Error ? e.message : 'error' })
    }
  },
  async create(input) {
    const row = await createAccount(input)
    // Conta principal é única: limpa a flag local antes de inserir o badge.
    const previous = input.is_default
      ? get().accounts.map((a) => (a.is_default ? { ...a, is_default: false } : a))
      : get().accounts
    set({ accounts: [...previous, row].sort(byName) })
    return row
  },
  async update(id, patch) {
    try {
      const row = await updateAccount(id, patch)
      set({ accounts: get().accounts.map((a) => (a.id === id ? { ...a, ...row } : a)) })
      return row
    } finally {
      // Sempre reconcilia com o banco — inclusive quando o update falha.
      await get().load({ silent: true })
    }
  },
  async remove(id) {
    await deleteAccount(id)
    set({ accounts: get().accounts.filter((a) => a.id !== id) })
  },
}))
