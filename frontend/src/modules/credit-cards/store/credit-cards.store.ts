import { create } from 'zustand'
import {
  createCreditCard,
  deleteCreditCard,
  listCreditCards,
  listInvoicesByCard,
  updateCreditCard,
  type CreditCardRow,
  type InvoiceRow,
} from '../service/credit-cards.service'
import type { CreditCardInput, CreditCardUpdateInput } from '../model/credit-card'

// C1.3 — store cartões (zustand): load/create/update/delete + silent + cache
// de faturas por cartão. Saldo/devedor exibido vem do banco (recalc/RPC).

interface LoadOptions {
  // `silent` não troca o status (evita skeleton em refresh pós-mutação).
  silent?: boolean
}

interface CreditCardsState {
  cards: CreditCardRow[]
  invoicesByCard: Record<string, InvoiceRow[]>
  selectedCardId: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  invoicesStatus: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  load: (options?: LoadOptions) => Promise<void>
  loadInvoices: (cardId: string, options?: LoadOptions) => Promise<void>
  create: (input: CreditCardInput) => Promise<CreditCardRow>
  update: (id: string, patch: CreditCardUpdateInput) => Promise<CreditCardRow>
  remove: (id: string) => Promise<void>
  selectCard: (id: string) => void
}

function byName(a: CreditCardRow, b: CreditCardRow): number {
  return a.name.localeCompare(b.name)
}

export const useCreditCardsStore = create<CreditCardsState>((set, get) => ({
  cards: [],
  invoicesByCard: {},
  selectedCardId: '',
  status: 'idle',
  invoicesStatus: 'idle',
  error: null,

  async load(options) {
    if (!options?.silent) set({ status: 'loading', error: null })
    try {
      const cards = await listCreditCards()
      set({ cards: [...cards].sort(byName), status: 'ready', error: null })
    } catch (e) {
      set({
        status: options?.silent ? get().status : 'error',
        error: e instanceof Error ? e.message : 'error',
      })
    }
  },

  async loadInvoices(cardId, options) {
    if (!options?.silent) set({ invoicesStatus: 'loading' })
    try {
      const invoices = await listInvoicesByCard(cardId)
      set({ invoicesByCard: { ...get().invoicesByCard, [cardId]: invoices }, invoicesStatus: 'ready' })
    } catch (e) {
      set({
        invoicesStatus: options?.silent ? get().invoicesStatus : 'error',
        error: e instanceof Error ? e.message : 'error',
      })
    }
  },

  async create(input) {
    const row = await createCreditCard(input)
    set({ cards: [...get().cards, row].sort(byName) })
    return row
  },

  async update(id, patch) {
    const row = await updateCreditCard(id, patch)
    set({ cards: get().cards.map((c) => (c.id === id ? { ...c, ...row } : c)) })
    return row
  },

  async remove(id) {
    await deleteCreditCard(id)
    const invoicesByCard = { ...get().invoicesByCard }
    delete invoicesByCard[id]
    set({ cards: get().cards.filter((c) => c.id !== id), invoicesByCard })
  },

  selectCard(id) {
    set({ selectedCardId: id })
  },
}))
