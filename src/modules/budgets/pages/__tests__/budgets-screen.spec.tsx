// @vitest-environment happy-dom
// O2.4 — TDD: BudgetsScreen (dono dos dados: store + adapter + nomes de
// categoria; toasts honestos via mapBudgetError + alerta ao estourar).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { useBudgetsStore } from '../../store/budgets.store'
import { useCategoriesStore } from '@/modules/categories/store/categories.store'
import { BudgetsScreen } from '../BudgetsScreen'
import type { BudgetRow } from '../../service/budgets.service'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

const budgetsServiceMocks = vi.hoisted(() => ({
  listBudgets: vi.fn(),
  createBudget: vi.fn(),
  updateBudget: vi.fn(),
  deleteBudget: vi.fn(),
  spendingByCategory: vi.fn(),
}))
vi.mock('../../service/budgets.service', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>
  return { ...original, ...budgetsServiceMocks }
})

const categoriesServiceMocks = vi.hoisted(() => ({
  listCategories: vi.fn(),
}))
vi.mock('@/modules/categories/service/categories.service', () => categoriesServiceMocks)

function budgetRow(overrides: Partial<BudgetRow> = {}): BudgetRow {
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

function renderScreen() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <BudgetsScreen initialMonth="2026-11-01" />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

beforeEach(() => {
  useBudgetsStore.setState({ budgets: [], spending: new Map(), status: 'idle', error: null, month: '' })
  useCategoriesStore.setState({ categories: [], status: 'idle', error: null })
  budgetsServiceMocks.listBudgets.mockResolvedValue([budgetRow()])
  budgetsServiceMocks.spendingByCategory.mockResolvedValue(new Map([['c1', 12000]]))
  budgetsServiceMocks.createBudget.mockResolvedValue(budgetRow())
  budgetsServiceMocks.deleteBudget.mockResolvedValue(undefined)
  categoriesServiceMocks.listCategories.mockResolvedValue([
    { id: 'c1', user_id: 'u1', name: 'Mercado', type: 'expense' },
  ])
  toastMocks.success.mockClear()
  toastMocks.error.mockClear()
  toastMocks.warning.mockClear()
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenBudgetsScreenLoads_thenViewsAttachCategoryNames', () => {
  it('lista com nome da categoria e barra de uso', async () => {
    renderScreen()
    expect(await screen.findByText('Mercado')).toBeTruthy()
    // Gasto 12000 > teto 10000: alerta ao estourar por texto.
    expect(screen.getByText(i18n.t('budgets.band.over'))).toBeTruthy()
  })

  it('troca de mês recarrega com dia 01', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByText('Mercado')
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.nextMonth') }))
    await waitFor(() => {
      expect(budgetsServiceMocks.listBudgets).toHaveBeenCalledWith('2026-12-01')
    })
  })
})

describe('whenBudgetMutates_thenToastsAreHonest', () => {
  it('criar teto já estourado: sucesso + alerta honesto (overToast)', async () => {
    const user = userEvent.setup()
    budgetsServiceMocks.listBudgets.mockResolvedValue([])
    budgetsServiceMocks.spendingByCategory.mockResolvedValue(new Map([['c1', 5000]]))
    budgetsServiceMocks.createBudget.mockResolvedValue(budgetRow({ id: 'b9', limit_cents: 1000 }))
    renderScreen()
    await screen.findByText(i18n.t('budgets.emptyTitle'))
    await user.click(within(screen.getByRole('search')).getByRole('button', { name: i18n.t('budgets.new') }))
    // Preenche categoria via combobox.
    await user.click(screen.getByRole('combobox', { name: `${i18n.t('budgets.category')} *` }))
    await user.click(await screen.findByRole('option', { name: 'Mercado' }))
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(screen.getByLabelText(`${i18n.t('budgets.limit')} *`), { target: { value: '1000' } })
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.create') }))
    await waitFor(() => expect(budgetsServiceMocks.createBudget).toHaveBeenCalled())
    expect(toastMocks.success).toHaveBeenCalledWith(i18n.t('budgets.toastCreated'))
    // Gasto 5000 > teto 1000: alerta honesto além do sucesso.
    expect(toastMocks.warning).toHaveBeenCalledWith(i18n.t('budgets.overToast'))
  })

  it('editar teto: sucesso + toast honesto (sem overToast quando dentro do teto)', async () => {
    const user = userEvent.setup()
    budgetsServiceMocks.listBudgets.mockResolvedValue([budgetRow()])
    budgetsServiceMocks.spendingByCategory.mockResolvedValue(new Map([['c1', 5000]]))
    budgetsServiceMocks.updateBudget.mockResolvedValue(budgetRow({ limit_cents: 20000 }))
    renderScreen()
    await screen.findByText('Mercado')
    await user.click(screen.getByText('Mercado'))
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(screen.getByLabelText(`${i18n.t('budgets.limit')} *`), { target: { value: '20000' } })
    await user.click(screen.getByRole('button', { name: i18n.t('common.save') }))
    await waitFor(() => expect(budgetsServiceMocks.updateBudget).toHaveBeenCalled())
    expect(toastMocks.success).toHaveBeenCalledWith(i18n.t('budgets.toastUpdated'))
    expect(toastMocks.warning).not.toHaveBeenCalled()
  })

  it('excluir teto: sucesso + toast honesto', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByText('Mercado')
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.actionsOpen', { name: 'Mercado' }) }))
    await user.click(screen.getByRole('menuitem', { name: i18n.t('budgets.remove') }))
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.deleteConfirm') }))
    await waitFor(() => expect(budgetsServiceMocks.deleteBudget).toHaveBeenCalledWith('b1'))
    expect(toastMocks.success).toHaveBeenCalledWith(i18n.t('budgets.toastRemoved'))
  })

  it('conflito unique vira duplicateError (via mapper centralizado)', async () => {
    const user = userEvent.setup()
    budgetsServiceMocks.listBudgets.mockResolvedValue([])
    budgetsServiceMocks.spendingByCategory.mockResolvedValue(new Map())
    const { BudgetAlreadyExistsError } = await import('../../service/budgets.service')
    budgetsServiceMocks.createBudget.mockRejectedValue(new BudgetAlreadyExistsError())
    renderScreen()
    await screen.findByText(i18n.t('budgets.emptyTitle'))
    await user.click(within(screen.getByRole('search')).getByRole('button', { name: i18n.t('budgets.new') }))
    await user.click(screen.getByRole('combobox', { name: `${i18n.t('budgets.category')} *` }))
    await user.click(await screen.findByRole('option', { name: 'Mercado' }))
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(screen.getByLabelText(`${i18n.t('budgets.limit')} *`), { target: { value: '1000' } })
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.create') }))
    await waitFor(() => {
      expect(screen.getByText(i18n.t('budgets.duplicateError'))).toBeTruthy()
    })
  })
})
