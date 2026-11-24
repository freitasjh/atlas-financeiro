import { beforeEach, describe, expect, it, vi } from 'vitest'

// C1.3 — store zustand (load/create/update/remove + silent reload).

const svc = vi.hoisted(() => ({
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  listCategories: vi.fn(),
}))
vi.mock('@/modules/categories/service/categories.service', () => svc)

import { useCategoriesStore } from '../categories.store'
import type { CategoryRow } from '../../service/categories.service'

function row(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: 'c1',
    user_id: 'u1',
    parent_id: null,
    name: 'Alimentação',
    type: 'expense',
    icon_code: null,
    color_hex: null,
    spending_limit_cents: 0,
    created_at: '',
    ...overrides,
  }
}

function reset(): void {
  useCategoriesStore.setState({ categories: [], status: 'ready', error: null })
  svc.createCategory.mockReset()
  svc.updateCategory.mockReset()
  svc.deleteCategory.mockReset()
  svc.listCategories.mockReset()
}

describe('whenLoadCategories_thenStatusTransitionsToReady', () => {
  beforeEach(reset)

  it('preenche categorias e limpa erro', async () => {
    svc.listCategories.mockResolvedValue([row()])
    useCategoriesStore.setState({ status: 'idle' })
    await useCategoriesStore.getState().load()
    const state = useCategoriesStore.getState()
    expect(state.categories).toHaveLength(1)
    expect(state.status).toBe('ready')
    expect(state.error).toBeNull()
  })

  it('silent não troca status em refresh pós-mutação', async () => {
    svc.listCategories.mockResolvedValue([row()])
    useCategoriesStore.setState({ status: 'ready' })
    await useCategoriesStore.getState().load({ silent: true })
    expect(useCategoriesStore.getState().status).toBe('ready')
  })

  it('erro de carga marca status error com chave i18n (cru só no console)', async () => {
    svc.listCategories.mockRejectedValue(new Error('load-failed'))
    await useCategoriesStore.getState().load()
    const state = useCategoriesStore.getState()
    expect(state.status).toBe('error')
    expect(state.error).toBe('categories.loadError')
  })
})

describe('whenCreateCategory_thenRowIsAppendedSorted', () => {
  beforeEach(reset)

  it('insere mantendo ordenação A→Z', async () => {
    useCategoriesStore.setState({ categories: [row({ id: 'b', name: 'Moradia' })] })
    svc.createCategory.mockResolvedValue(row({ id: 'a', name: 'Alimentação' }))
    await useCategoriesStore.getState().create({ name: 'Alimentação', type: 'expense' })
    expect(useCategoriesStore.getState().categories.map((c) => c.name)).toEqual([
      'Alimentação',
      'Moradia',
    ])
  })
})

describe('whenUpdateCategory_thenStoreReconcilesSilently', () => {
  beforeEach(reset)

  it('reconcilia com o banco mesmo no erro e propaga a falha', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    useCategoriesStore.setState({ categories: [row()], load })
    svc.updateCategory.mockRejectedValue(new Error('category-system-protected'))

    await expect(useCategoriesStore.getState().update('c1', { name: 'X' })).rejects.toThrow(
      /category-system-protected/,
    )
    expect(load).toHaveBeenCalledWith({ silent: true })
  })

  it('sucesso não recarrega (reconciliação local cobre)', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    useCategoriesStore.setState({ categories: [row()], load })
    svc.updateCategory.mockResolvedValue(row({ name: 'X' }))

    await useCategoriesStore.getState().update('c1', { name: 'X' })
    expect(load).not.toHaveBeenCalled()
    expect(useCategoriesStore.getState().categories[0]?.name).toBe('X')
  })
})

describe('whenRemoveCategory_thenRowIsDropped', () => {
  beforeEach(reset)

  it('remove do estado após delete no servidor', async () => {
    useCategoriesStore.setState({ categories: [row({ id: 'a' }), row({ id: 'b', name: 'Z' })] })
    svc.deleteCategory.mockResolvedValue(undefined)
    await useCategoriesStore.getState().remove('a')
    expect(useCategoriesStore.getState().categories.map((c) => c.id)).toEqual(['b'])
  })

  it('propaga category-in-use sem alterar o estado', async () => {
    useCategoriesStore.setState({ categories: [row({ id: 'a' })] })
    svc.deleteCategory.mockRejectedValue(new Error('category-in-use'))
    await expect(useCategoriesStore.getState().remove('a')).rejects.toThrow(/category-in-use/)
    expect(useCategoriesStore.getState().categories).toHaveLength(1)
  })
})
