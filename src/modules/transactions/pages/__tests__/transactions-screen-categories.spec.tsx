// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'

import { TransactionsScreen } from '../TransactionsScreen'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

const loadTransactions = vi.fn().mockResolvedValue(undefined)
const loadAccounts = vi.fn().mockResolvedValue(undefined)
const loadCategories = vi.fn().mockResolvedValue(undefined)

vi.mock('../../store/transactions.store', () => ({
  useTransactionsStore: (sel: (s: unknown) => unknown) =>
    sel({
      transactions: [],
      status: 'ready',
      load: loadTransactions,
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    }),
}))

vi.mock('@/modules/accounts/store/accounts.store', () => ({
  useAccountsStore: (sel: (s: unknown) => unknown) =>
    sel({
      accounts: [{ id: 'acc-1', name: 'Conta principal' }],
      status: 'ready',
      load: loadAccounts,
    }),
}))

vi.mock('@/modules/categories/store/categories.store', () => ({
  useCategoriesStore: (sel: (s: unknown) => unknown) =>
    sel({
      categories: [
        { id: 'cat-mercado', name: 'Mercado', type: 'expense' },
        { id: 'cat-salario', name: 'Salário', type: 'income' },
      ],
      status: 'ready',
      load: loadCategories,
    }),
}))

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenScreenMounts_thenLoadsCategoriesSilently', () => {
  it('chama load de categorias sem bloquear a tela e repassa ao modal', async () => {
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={i18n}>
        <TransactionsScreen />
      </I18nextProvider>,
    )
    expect(loadCategories).toHaveBeenCalledWith({ silent: true })
    await user.click(screen.getByRole('button', { name: /Nova Transação/ }))
    await user.click(screen.getByLabelText(/Categoria/))
    // tipo padrão do formulário é receita: categoria de receita visível
    expect(await screen.findByRole('option', { name: 'Salário' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Sem categoria' })).toBeTruthy()
  })
})
