import { beforeEach, describe, expect, it, vi } from 'vitest'

// O1.3 — store zustand (load/create/update/remove + silent reload).

const svc = vi.hoisted(() => ({
  listBudgets: vi.fn(),
  createBudget: vi.fn(),
  updateBudget: vi.fn(),
  deleteBudget: vi.fn(),
  spendingByCategory: vi.fn(),
}))
vi.mock('@/modules/budgets/service/budgets.service', () => svc)

import { useBudgetsStore } from '../budgets.store'
import type { BudgetRow } from '../../service/budgets.service'

function row(overrides: Partial<BudgetRow> = {}): BudgetRow {
  return {
    id: 'b1',
    user_id: 'u1',
    category_id: 'c1',
    month: '2026-11-01',
    tenant_id: null,
    limit_cents: 10000,
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

function reset(): void {
  useBudgetsStore.setState({ budgets: [], spending: new Map(), status: 'idle', error: null, month: '2026-11-01' })
  svc.listBudgets.mockReset()
  svc.createBudget.mockReset()
  svc.updateBudget.mockReset()
  svc.deleteBudget.mockReset()
  svc.spendingByCategory.mockReset()
  svc.spendingByCategory.mockResolvedValue(new Map())
}

describe('whenLoadBudgets_thenStatusTransitionsToReady', () => {
  beforeEach(reset)

  it('preenche tetos + gasto e limpa erro', async () => {
    svc.listBudgets.mockResolvedValue([row()])
    svc.spendingByCategory.mockResolvedValue(new Map([['c1', 5000]]))
    useBudgetsStore.setState({ status: 'idle' })
    await useBudgetsStore.getState().load('2026-11-01')
    const state = useBudgetsStore.getState()
    expect(state.budgets).toHaveLength(1)
    expect(state.spending.get('c1')).toBe(5000)
    expect(state.status).toBe('ready')
    expect(state.error).toBeNull()
  })

  it('silent não troca status em refresh pós-mutação', async () => {
    svc.listBudgets.mockResolvedValue([row()])
    useBudgetsStore.setState({ status: 'ready' })
    await useBudgetsStore.getState().load('2026-11-01', { silent: true })
    expect(useBudgetsStore.getState().status).toBe('ready')
  })

  it('erro de carga marca status error com chave loadError (cru só no console)', async () => {
    svc.listBudgets.mockRejectedValue(new Error('load-failed'))
    await useBudgetsStore.getState().load('2026-11-01')
    const state = useBudgetsStore.getState()
    expect(state.status).toBe('error')
    expect(state.error).toBe('budgets.loadError')
  })

  it('erro de carga em refresh silencioso preserva status ready', async () => {
    svc.listBudgets.mockResolvedValue([row()])
    useBudgetsStore.setState({ status: 'ready' })
    svc.listBudgets.mockRejectedValue(new Error('load-failed'))
    await useBudgetsStore.getState().load('2026-11-01', { silent: true })
    const state = useBudgetsStore.getState()
    expect(state.status).toBe('ready')
    expect(state.error).toBe('budgets.loadError')
  })
})

describe('whenMutatingBudgets_thenStateReconciles', () => {
  beforeEach(reset)

  it('create anexa linha e recarrega gasto silencioso', async () => {
    svc.createBudget.mockResolvedValue(row())
    svc.listBudgets.mockResolvedValue([row()])
    await useBudgetsStore.getState().create({
      category_id: '123e4567-e89b-12d3-a456-426614174000',
      month: '2026-11-01',
      limit_cents: 10000,
    })
    expect(useBudgetsStore.getState().budgets).toHaveLength(1)
    expect(svc.spendingByCategory).toHaveBeenCalled()
  })

  it('update reconcilia linha local sem reload barulhento', async () => {
    svc.listBudgets.mockResolvedValue([row()])
    await useBudgetsStore.getState().load('2026-11-01')
    svc.updateBudget.mockResolvedValue(row({ limit_cents: 20000 }))
    const updated = await useBudgetsStore.getState().update('b1', { limit_cents: 20000 })
    expect(updated.limit_cents).toBe(20000)
    expect(useBudgetsStore.getState().budgets[0]?.limit_cents).toBe(20000)
    expect(useBudgetsStore.getState().status).toBe('ready')
  })

  it('remove exclui local após delete no servidor (CASCADE documentado, sem bloqueio)', async () => {
    svc.listBudgets.mockResolvedValue([row()])
    await useBudgetsStore.getState().load('2026-11-01')
    svc.deleteBudget.mockResolvedValue(undefined)
    await useBudgetsStore.getState().remove('b1')
    expect(useBudgetsStore.getState().budgets).toHaveLength(0)
  })
})
