import { beforeEach, describe, expect, it, vi } from 'vitest'

// C1.2 — service Supabase: RLS user_id, bloqueio em-uso no servidor,
// seed protegida no servidor, sem cascade silencioso.

const sbMocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, auth: { getUser: sbMocks.getUser } },
}))

interface TxRow {
  category_id: string | null
}

function categoryRow(overrides: Record<string, unknown> = {}) {
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

describe('whenListCategories_thenScopesByUserId', () => {
  beforeEach(() => {
    sbMocks.from.mockReset()
    sbMocks.getUser.mockReset()
    sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  })

  it('filtra por user_id e ordena por nome', async () => {
    const seen: Array<{ table: string; col: string; val: unknown }> = []
    sbMocks.from.mockImplementation((table: string) => {
      const chain: Record<string, (...args: never[]) => unknown> = {}
      chain.select = (() => chain) as never
      chain.eq = ((col: never, val: never) => {
        seen.push({ table, col: col as string, val: val as unknown })
        return chain
      }) as never
      chain.order = (() => ({ data: [], error: null })) as never
      return chain
    })
    const { listCategories } = await import('@/modules/categories/service/categories.service')
    await listCategories()
    expect(sbMocks.from).toHaveBeenCalledWith('categories')
    expect(seen).toContainEqual({ table: 'categories', col: 'user_id', val: 'u1' })
  })

  it('recusa sem sessão', async () => {
    sbMocks.getUser.mockResolvedValue({ data: { user: null } })
    const { listCategories } = await import('@/modules/categories/service/categories.service')
    await expect(listCategories()).rejects.toThrow('unauthenticated')
  })
})

describe('whenCreateCategory_thenWritesOnlyAllowedColumns', () => {
  beforeEach(() => {
    sbMocks.from.mockReset()
    sbMocks.getUser.mockReset()
    sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  })

  it('insere user_id + name/type/color_hex (sem parent_id, sem is_system)', async () => {
    let inserted: Record<string, unknown> | null = null
    sbMocks.from.mockImplementation(() => ({
      insert: (payload: unknown) => {
        inserted = payload as Record<string, unknown>
        return { select: () => ({ single: async () => ({ data: categoryRow(), error: null }) }) }
      },
    }))
    const { createCategory } = await import('@/modules/categories/service/categories.service')
    await createCategory({ name: ' Lazer ', type: 'expense', color: '#fff' })
    expect(inserted).toMatchObject({ user_id: 'u1', name: 'Lazer', type: 'expense', color_hex: '#fff' })
    expect(inserted).not.toHaveProperty('parent_id')
    expect(inserted).not.toHaveProperty('is_system')
  })
})

describe('whenDeleteCategory_thenServerBlocksInUseAndSystem', () => {
  beforeEach(() => {
    sbMocks.from.mockReset()
    sbMocks.getUser.mockReset()
    sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  })

  function setup(row: Record<string, unknown> | null, usage: number) {
    sbMocks.from.mockImplementation((table: string) => {
      if (table === 'categories') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
          }),
          delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        }
      }
      // transactions: contagem head para checagem de uso
      return {
        select: () => ({
          eq: () => ({ eq: async () => ({ count: usage, error: null }) }),
        }),
      }
    })
  }

  it('exclui categoria livre (sem lançamentos)', async () => {
    setup(categoryRow(), 0)
    const { deleteCategory } = await import('@/modules/categories/service/categories.service')
    await expect(deleteCategory('c1')).resolves.toBeUndefined()
  })

  it('recusa com category-in-use quando há lançamentos (sem cascade silencioso)', async () => {
    setup(categoryRow(), 4)
    const { deleteCategory, CategoryInUseError } = await import(
      '@/modules/categories/service/categories.service'
    )
    const err = await deleteCategory('c1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CategoryInUseError)
    expect((err as Error).message).toBe('category-in-use')
  })

  it('recusa categoria de sistema mesmo com uso zero', async () => {
    setup({ ...categoryRow(), is_system: true }, 0)
    const { deleteCategory } = await import('@/modules/categories/service/categories.service')
    await expect(deleteCategory('c1')).rejects.toThrow('category-system-protected')
  })

  it('recusa categoria inexistente', async () => {
    setup(null, 0)
    const { deleteCategory } = await import('@/modules/categories/service/categories.service')
    await expect(deleteCategory('c1')).rejects.toThrow('category-not-found')
  })
})

describe('whenUpdateCategory_thenServerProtectsSystemRows', () => {
  beforeEach(() => {
    sbMocks.from.mockReset()
    sbMocks.getUser.mockReset()
    sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  })

  it('recusa update de categoria de sistema', async () => {
    sbMocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { ...categoryRow(), is_system: true }, error: null }),
          }),
        }),
      }),
    }))
    const { updateCategory } = await import('@/modules/categories/service/categories.service')
    await expect(updateCategory('c1', { name: 'X' })).rejects.toThrow('category-system-protected')
  })
})

describe('whenUsageCountsAreFetched_thenSingleQueryBuildsMap', () => {
  beforeEach(() => {
    sbMocks.from.mockReset()
    sbMocks.getUser.mockReset()
    sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  })

  it('uma query com IN retorna Map de contagens', async () => {
    const txs: TxRow[] = [{ category_id: 'a' }, { category_id: 'a' }, { category_id: null }]
    sbMocks.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ in: async () => ({ data: txs, error: null }) }) }),
    }))
    const { countCategoriesUsage } = await import('@/modules/categories/service/categories.service')
    const counts = await countCategoriesUsage(['a', 'b'])
    expect(counts.get('a')).toBe(2)
    expect(counts.get('b') ?? 0).toBe(0)
  })

  it('lista vazia não consulta o banco', async () => {
    const { countCategoriesUsage } = await import('@/modules/categories/service/categories.service')
    const counts = await countCategoriesUsage([])
    expect(counts.size).toBe(0)
    expect(sbMocks.from).not.toHaveBeenCalled()
  })
})
