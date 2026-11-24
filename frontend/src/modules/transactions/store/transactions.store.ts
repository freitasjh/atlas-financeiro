import { create } from 'zustand'
import {
  createTransaction,
  deleteTransaction,
  listTransactions,
  updateTransaction,
  type TransactionCreate,
  type TransactionRow,
  type TransactionUpdate,
} from '../service/transactions.service'
import { useAccountsStore } from '@/modules/accounts/store/accounts.store'

interface LoadOptions {
  page?: number
  pageSize?: number
  search?: string
  type?: string
  status?: string
  from?: string
  to?: string
  silent?: boolean
}

interface TransactionsState {
  transactions: TransactionRow[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  count: number
  page: number
  pageSize: number
  load: (options?: LoadOptions) => Promise<void>
  create: (input: TransactionCreate) => Promise<TransactionRow>
  update: (id: string, patch: TransactionUpdate) => Promise<TransactionRow>
  remove: (id: string) => Promise<void>
  setPage: (page: number) => void
}

export const useTransactionsStore = create<TransactionsState>((set, get) => ({
  transactions: [],
  status: 'idle',
  error: null,
  count: 0,
  page: 1,
  pageSize: 50,
  async load(options) {
    const page = options?.page ?? get().page
    const pageSize = options?.pageSize ?? get().pageSize
    if (!options?.silent) set({ status: 'loading', error: null })
    try {
      const { rows, count } = await listTransactions({ ...options, page, pageSize })
      set({ transactions: rows, count, page, pageSize, status: 'ready', error: null })
    } catch (e) {
      set({ status: options?.silent ? get().status : 'error', error: e instanceof Error ? e.message : 'error' })
    }
  },
  async create(input) {
    try {
      const row = await createTransaction(input)
      set({ transactions: [row, ...get().transactions], count: get().count + 1 })
      return row
    } catch (e) {
      try {
        await get().load({ silent: true })
      } catch {
        // ignora falha de ressincronização
      }
      throw e
    } finally {
      try {
        await useAccountsStore.getState().load({ silent: true })
      } catch {
        // ignora falha de recarga de contas
      }
    }
  },
  async update(id, patch) {
    try {
      const row = await updateTransaction(id, patch)
      set({ transactions: get().transactions.map((t) => (t.id === id ? { ...t, ...row } : t)) })
      return row
    } catch (e) {
      try {
        await get().load({ silent: true })
      } catch {
        // ignora falha de ressincronização
      }
      throw e
    } finally {
      try {
        await useAccountsStore.getState().load({ silent: true })
      } catch {
        // ignora falha de recarga de contas
      }
    }
  },
  async remove(id) {
    try {
      await deleteTransaction(id)
      set({ transactions: get().transactions.filter((t) => t.id !== id), count: Math.max(0, get().count - 1) })
    } catch (e) {
      try {
        await get().load({ silent: true })
      } catch {
        // ignora falha de ressincronização
      }
      throw e
    } finally {
      try {
        await useAccountsStore.getState().load({ silent: true })
      } catch {
        // ignora falha de recarga de contas
      }
    }
  },
  setPage(page) {
    set({ page })
  },
}))
