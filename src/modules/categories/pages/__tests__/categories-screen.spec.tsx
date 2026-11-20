// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { useCategoriesStore } from '../../store/categories.store'
import { CategoriesScreen } from '../CategoriesScreen'
import type { CategoryRow } from '../../service/categories.service'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

const serviceMocks = vi.hoisted(() => ({
  listCategories: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  countCategoryUsage: vi.fn(),
  countCategoriesUsage: vi.fn(),
}))
vi.mock('../../service/categories.service', () => serviceMocks)

function row(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: 'c1',
    user_id: 'u1',
    name: 'Mercado',
    type: 'expense',
    color_hex: null,
    icon_code: null,
    spending_limit_cents: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as CategoryRow
}

function renderScreen() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <CategoriesScreen />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

beforeEach(() => {
  useCategoriesStore.setState({ categories: [], status: 'idle', error: null })
  serviceMocks.listCategories.mockResolvedValue([row()])
  serviceMocks.countCategoriesUsage.mockResolvedValue(new Map([['c1', 4]]))
  serviceMocks.countCategoryUsage.mockResolvedValue(0)
  toastMocks.success.mockClear()
  toastMocks.error.mockClear()
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

// C2.1 — Screen: store + adapter + contagens sem N+1 (1 chamada em lote).
describe('whenCategoriesScreenLoads_thenUsageCountsAttachInOneBatch', () => {
  it('lista com contagem de uso e KPI global', async () => {
    renderScreen()
    expect(await screen.findByText('Mercado')).toBeTruthy()
    await waitFor(() => {
      expect(serviceMocks.countCategoriesUsage).toHaveBeenCalledTimes(1)
    })
    expect(serviceMocks.countCategoriesUsage).toHaveBeenCalledWith(['c1'])
    expect(screen.getByText(i18n.t('categories.footerShowing', { shown: 1, total: 1 }))).toBeTruthy()
  })
})

describe('whenCategoryIsCreated_thenStorePersistsAndToastConfirms', () => {
  it('criar via dialog persiste e confirma', async () => {
    const user = userEvent.setup()
    serviceMocks.createCategory.mockImplementation(async (input: unknown) => row({ id: 'c2', ...(input as object) }))
    renderScreen()
    expect(await screen.findByText('Mercado')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: i18n.t('categories.new') }))
    await user.type(screen.getByLabelText(/nome/i), 'Salário')
    await user.click(screen.getByRole('radio', { name: i18n.t('categories.typeIncome') }))
    await user.click(screen.getByRole('button', { name: i18n.t('categories.create') }))
    await waitFor(() => {
      expect(serviceMocks.createCategory).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Salário', type: 'income' }),
      )
    })
    expect(toastMocks.success).toHaveBeenCalledWith(i18n.t('categories.toastCreated'))
  })
})
