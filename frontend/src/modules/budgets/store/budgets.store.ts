import { create } from 'zustand'
import {
  createBudget,
  deleteBudget,
  listBudgets,
  spendingByCategory,
  updateBudget,
  type BudgetRow,
} from '../service/budgets.service'
import type { BudgetInput, BudgetPatchInput } from '../model/budget'

// O1.3 — store orçamentos (zustand). Mesmo padrão de categories.store:
// load carrega tetos + gasto agregado; silent evita skeleton em refresh.

interface LoadOptions {
  /** silent não troca o status (evita skeleton em refresh pós-mutação). */
  silent?: boolean
}

interface BudgetsState {
  budgets: BudgetRow[]
  spending: Map<string, number>
  month: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  load: (month: string, options?: LoadOptions) => Promise<void>
  create: (input: BudgetInput) => Promise<BudgetRow>
  update: (id: string, patch: BudgetPatchInput) => Promise<BudgetRow>
  remove: (id: string) => Promise<void>
}

export const useBudgetsStore = create<BudgetsState>((set, get) => ({
  budgets: [],
  spending: new Map(),
  month: '',
  status: 'idle',
  error: null,
  async load(month, options) {
    if (!options?.silent) set({ status: 'loading', error: null, month })
    else set({ month })
    try {
      const [budgets, spending] = await Promise.all([
        listBudgets(month),
        spendingByCategory(month),
      ])
      set({ budgets, spending, month, status: 'ready', error: null })
    } catch (e) {
      // Erro cru nunca vaza para a UI: log técnico aqui, chave i18n no estado.
      console.error('[budgets] load failed', e)
      set({ status: options?.silent ? get().status : 'error', error: 'budgets.loadError' })
    }
  },
  async create(input) {
    const row = await createBudget(input)
    set({ budgets: [...get().budgets, row], month: row.month })
    // Gasto do mês pode mudar a barra do novo teto: refresh silencioso.
    await get().load(row.month, { silent: true })
    return row
  },
  async update(id, patch) {
    try {
      const row = await updateBudget(id, patch)
      set({ budgets: get().budgets.map((b) => (b.id === id ? { ...b, ...row } : b)) })
      return row
    } catch (e) {
      // Reconciliação local cobre o sucesso; reload silencioso só no erro.
      const month = get().month
      if (month) await get().load(month, { silent: true })
      throw e
    }
  },
  async remove(id) {
    await deleteBudget(id)
    set({ budgets: get().budgets.filter((b) => b.id !== id) })
  },
}))
