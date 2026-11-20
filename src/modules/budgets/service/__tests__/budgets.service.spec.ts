import { beforeEach, describe, expect, it, vi } from 'vitest'

// O1.2 — service Supabase: RLS user_id, conflito unique traduzido, gasto agregado 1 query.

const sbMocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, auth: { getUser: sbMocks.getUser } },
}))

const VALID_ID = '123e4567-e89b-12d3-a456-426614174000'

function chainable(final: { data: unknown; error: unknown }) {
  const chain: Record<string, (...args: unknown[]) => unknown> = {}
  const terminal = ['single', 'maybeSingle', 'order'] as const
  for (const key of [
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'gte',
    'lt',
    'order',
    'single',
    'maybeSingle',
  ]) {
    chain[key] = (..._args: unknown[]) =>
      (terminal as readonly string[]).includes(key) ? final : chain
  }
  return chain
}

beforeEach(() => {
  sbMocks.from.mockReset()
  sbMocks.getUser.mockReset()
  sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
})

describe('whenListBudgets_thenScopesByUserAndMonth', () => {
  it('filtra por user_id + month e ordena', async () => {
    const seen: Array<{ col: string; val: unknown }> = []
    sbMocks.from.mockImplementation(() => {
      const chain: Record<string, (...args: unknown[]) => unknown> = {}
      chain.select = () => chain
      chain.eq = (col: unknown, val: unknown) => {
        seen.push({ col: col as string, val })
        return chain
      }
      chain.order = () => ({ data: [], error: null })
      return chain
    })
    const { listBudgets } = await import('@/modules/budgets/service/budgets.service')
    await listBudgets('2026-11-01')
    expect(sbMocks.from).toHaveBeenCalledWith('budgets')
    expect(seen).toContainEqual({ col: 'user_id', val: 'u1' })
    expect(seen).toContainEqual({ col: 'month', val: '2026-11-01' })
  })

  it('recusa sem sessão', async () => {
    sbMocks.getUser.mockResolvedValue({ data: { user: null } })
    const { listBudgets } = await import('@/modules/budgets/service/budgets.service')
    await expect(listBudgets('2026-11-01')).rejects.toThrow('unauthenticated')
  })
})

describe('whenCreateBudget_thenConflictBecomesTypedError', () => {
  it('insere user_id + category_id + month + limit_cents', async () => {
    let inserted: Record<string, unknown> | null = null
    sbMocks.from.mockImplementation(() => {
      const chain: Record<string, (...args: unknown[]) => unknown> = {}
      chain.insert = (payload: unknown) => {
        inserted = payload as Record<string, unknown>
        return chain
      }
      chain.select = () => chain
      chain.single = () => ({ data: { id: 'b1' }, error: null })
      return chain
    })
    const { createBudget } = await import('@/modules/budgets/service/budgets.service')
    await createBudget({ category_id: VALID_ID, month: '2026-11-01', limit_cents: 15000 })
    expect(inserted).toMatchObject({
      user_id: 'u1',
      category_id: VALID_ID,
      month: '2026-11-01',
      limit_cents: 15000,
    })
  })

  it('unique violado vira BudgetAlreadyExistsError (mensagem honesta)', async () => {
    sbMocks.from.mockImplementation(() => chainable({ data: null, error: { code: '23505' } }))
    const { createBudget, BudgetAlreadyExistsError } = await import(
      '@/modules/budgets/service/budgets.service'
    )
    const err = await createBudget({
      category_id: VALID_ID,
      month: '2026-11-01',
      limit_cents: 15000,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BudgetAlreadyExistsError)
    expect((err as Error).message).toBe('budget-already-exists')
  })
})

describe('whenSpendingByCategory_thenSingleAggregatedQuery', () => {
  it('1 chamada from(transactions) com filtros type/is_transfer/mês; agrega no cliente', async () => {
    const calls: Array<{ col: string; val: unknown }> = []
    let fromTables: string[] = []
    sbMocks.from.mockImplementation((table: string) => {
      fromTables = [...fromTables, table]
      const chain: Record<string, (...args: unknown[]) => unknown> = {}
      chain.select = () => chain
      chain.eq = (col: unknown, val: unknown) => {
        calls.push({ col: col as string, val })
        return chain
      }
      chain.gte = (col: unknown, val: unknown) => {
        calls.push({ col: `gte:${col as string}`, val })
        return chain
      }
      chain.lt = (col: unknown, val: unknown) => {
        calls.push({ col: `lt:${col as string}`, val })
        return Promise.resolve({
          data: [
            { category_id: 'c1', amount_cents: 5000 },
            { category_id: 'c1', amount_cents: 3000 },
            { category_id: null, amount_cents: 99 },
          ],
          error: null,
        })
      }
      return chain
    })
    const { spendingByCategory } = await import('@/modules/budgets/service/budgets.service')
    const map = await spendingByCategory('2026-11-01')
    expect(fromTables.filter((t) => t === 'transactions')).toHaveLength(1)
    expect(calls).toContainEqual({ col: 'user_id', val: 'u1' })
    expect(calls).toContainEqual({ col: 'type', val: 'expense' })
    expect(calls).toContainEqual({ col: 'is_transfer', val: false })
    expect(calls).toContainEqual({ col: 'gte:date', val: '2026-11-01' })
    expect(calls).toContainEqual({ col: 'lt:date', val: '2026-12-01' })
    expect(map.get('c1')).toBe(8000)
    expect(map.has('null')).toBe(false)
  })
})
