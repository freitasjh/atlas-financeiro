import { create } from 'zustand'
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
  type CategoryRow,
} from '../service/categories.service'
import type { CategoryInput, CategoryPatchInput } from '../model/category'

// C1.3 — store categorias (zustand). Ordenação A→Z local; update reconcilia
// silencioso com o banco inclusive no erro (mesmo padrão de accounts.store).

interface LoadOptions {
  /** silent não troca o status (evita skeleton em refresh pós-mutação). */
  silent?: boolean
}

interface CategoriesState {
  categories: CategoryRow[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  load: (options?: LoadOptions) => Promise<void>
  create: (input: CategoryInput) => Promise<CategoryRow>
  update: (id: string, patch: CategoryPatchInput) => Promise<CategoryRow>
  remove: (id: string) => Promise<void>
}

function byName(a: CategoryRow, b: CategoryRow): number {
  return a.name.localeCompare(b.name, 'pt-BR')
}

export const useCategoriesStore = create<CategoriesState>((set, get) => ({
  categories: [],
  status: 'idle',
  error: null,
  async load(options) {
    if (!options?.silent) set({ status: 'loading', error: null })
    try {
      const categories = await listCategories()
      set({ categories: [...categories].sort(byName), status: 'ready', error: null })
    } catch (e) {
      // Erro cru nunca vaza para a UI: log técnico aqui, chave i18n no estado.
      console.error('[categories] load failed', e)
      set({ status: options?.silent ? get().status : 'error', error: 'categories.loadError' })
    }
  },
  async create(input) {
    const row = await createCategory(input)
    set({ categories: [...get().categories, row].sort(byName) })
    return row
  },
  async update(id, patch) {
    try {
      const row = await updateCategory(id, patch)
      set({ categories: get().categories.map((c) => (c.id === id ? { ...c, ...row } : c)) })
      return row
    } catch (e) {
      // Reconciliação local cobre o sucesso; reload silencioso só no erro.
      await get().load({ silent: true })
      throw e
    }
  },
  async remove(id) {
    await deleteCategory(id)
    set({ categories: get().categories.filter((c) => c.id !== id) })
  },
}))
