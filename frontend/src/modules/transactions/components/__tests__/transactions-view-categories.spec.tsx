// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'

import { TransactionsView } from '../TransactionsView'
import type { TransactionView } from '../../model/view-model'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

function view(id: string, overrides: Partial<TransactionView> = {}): TransactionView {
  return {
    id,
    accountId: 'acc-1',
    categoryId: null,
    date: '2026-05-10',
    amountCents: 100000,
    description: 'Lançamento teste',
    type: 'income',
    status: 'posted',
    installmentPlanId: null,
    accountName: 'Conta',
    categoryName: undefined,
    ...overrides,
  }
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenViewReceivesCategories_thenDialogListsRealOnes', () => {
  it('abre o modal e exibe as categorias repassadas pela view', async () => {
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={i18n}>
        <TransactionsView
          transactions={[view('t1')]}
          categories={[
            { id: 'cat-mercado', name: 'Mercado', type: 'expense' },
            { id: 'cat-salario', name: 'Salário', type: 'income' },
          ]}
        />
      </I18nextProvider>,
    )
    await user.click(screen.getByRole('button', { name: /Nova Transação/ }))
    await user.click(screen.getByLabelText(/Categoria/))
    // tipo padrão do formulário é receita: categoria de receita visível
    expect(await screen.findByRole('option', { name: 'Salário' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Sem categoria' })).toBeTruthy()
  })
})
