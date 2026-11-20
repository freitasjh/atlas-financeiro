// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { useCategoriesStore } from '../../store/categories.store'
import { CategoriesScreen } from '../CategoriesScreen'
import type { CategoryRow } from '../../service/categories.service'
import {
  CategoryInUseError,
  CategorySystemProtectedError,
} from '../../service/categories.service'

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
vi.mock('../../service/categories.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../service/categories.service')>()
  return { ...actual, ...serviceMocks }
})

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
  serviceMocks.countCategoriesUsage.mockResolvedValue(new Map([['c1', 0]]))
  serviceMocks.countCategoryUsage.mockResolvedValue(0)
  serviceMocks.createCategory.mockImplementation(async (input: unknown) =>
    row({ id: 'c2', ...(input as object) }),
  )
  serviceMocks.updateCategory.mockImplementation(async (_id: string, patch: unknown) =>
    row({ ...(patch as object) }),
  )
  serviceMocks.deleteCategory.mockResolvedValue(undefined)
  toastMocks.success.mockClear()
  toastMocks.error.mockClear()
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenCategoryIsUpdated_thenStorePersistsAndToastConfirms', () => {
  it('editar via linha persiste patch e confirma', async () => {
    const user = userEvent.setup()
    renderScreen()
    expect(await screen.findByText('Mercado')).toBeTruthy()
    await user.click(screen.getByText('Mercado'))
    const dialog = await screen.findByRole('dialog')
    const nameInput = within(dialog).getByLabelText(/nome/i)
    await user.clear(nameInput)
    await user.type(nameInput, 'Mercado Novo')
    await user.click(within(dialog).getByRole('button', { name: i18n.t('categories.update') }))
    await waitFor(() => {
      expect(serviceMocks.updateCategory).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ name: 'Mercado Novo' }),
      )
    })
    expect(toastMocks.success).toHaveBeenCalledWith(i18n.t('categories.toastUpdated'))
  })
})

describe('whenCategoryIsRemoved_thenToastConfirms', () => {
  it('excluir categoria livre remove e confirma com toast', async () => {
    const user = userEvent.setup()
    renderScreen()
    expect(await screen.findByText('Mercado')).toBeTruthy()
    await user.click(
      screen.getByRole('button', { name: i18n.t('categories.actionsOpen', { name: 'Mercado' }) }),
    )
    await user.click(screen.getByRole('menuitem', { name: i18n.t('categories.remove') }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: i18n.t('categories.deleteConfirm') }))
    await waitFor(() => {
      expect(serviceMocks.deleteCategory).toHaveBeenCalledWith('c1')
    })
    expect(toastMocks.success).toHaveBeenCalledWith(i18n.t('categories.toastRemoved'))
  })

  it('excluir em uso (corrida no servidor) abre BlockedDialog, sem toast de sucesso', async () => {
    const user = userEvent.setup()
    serviceMocks.deleteCategory.mockRejectedValueOnce(new CategoryInUseError(4))
    serviceMocks.countCategoryUsage.mockResolvedValueOnce(0).mockResolvedValueOnce(4)
    renderScreen()
    expect(await screen.findByText('Mercado')).toBeTruthy()
    await user.click(
      screen.getByRole('button', { name: i18n.t('categories.actionsOpen', { name: 'Mercado' }) }),
    )
    await user.click(screen.getByRole('menuitem', { name: i18n.t('categories.remove') }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: i18n.t('categories.deleteConfirm') }))
    expect(await screen.findByText(i18n.t('categories.blockedTitle'))).toBeTruthy()
    expect(screen.getByText(i18n.t('categories.blockedCount', { count: 4 }))).toBeTruthy()
    expect(toastMocks.success).not.toHaveBeenCalled()
  })
})

describe('whenCategoriesLoadFails_thenErrorAndRetry', () => {
  it('erro de load mostra chave i18n (cru só no console) e retry recarrega', async () => {
    const user = userEvent.setup()
    serviceMocks.listCategories.mockRejectedValueOnce(new Error('offline'))
    renderScreen()
    expect(await screen.findByText(i18n.t('categories.loadError'))).toBeTruthy()
    expect(screen.queryByText('offline')).toBeNull()
    serviceMocks.listCategories.mockResolvedValue([row()])
    await user.click(screen.getByRole('button', { name: i18n.t('categories.retry') }))
    expect(await screen.findByText('Mercado')).toBeTruthy()
  })
})

describe('whenSystemCategoryIsWritten_thenHonestError', () => {
  it('criar protegida exibe erro de sistema no dialog (sem fechar)', async () => {
    const user = userEvent.setup()
    serviceMocks.createCategory.mockRejectedValueOnce(new CategorySystemProtectedError())
    renderScreen()
    expect(await screen.findByText('Mercado')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: i18n.t('categories.new') }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/nome/i), 'Seed')
    await user.click(within(dialog).getByRole('button', { name: i18n.t('categories.create') }))
    expect(await within(dialog).findByText(i18n.t('categories.systemProtectedError'))).toBeTruthy()
  })
})
