// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
    categoryName: 'Geral',
    ...overrides,
  }
}

function renderWithI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenTransactionsViewRenders_thenEmptyStateIsShown', () => {
  it('lista vazia mostra tabela sem linhas', () => {
    renderWithI18n(<TransactionsView transactions={[]} />)
    expect(screen.getByText(/Nenhuma transação encontrada/i)).toBeTruthy()
  })
})

describe('whenTransactionsViewRendersWithData_thenRowsAreShown', () => {
  it('renderiza a descrição da transação', () => {
    renderWithI18n(<TransactionsView transactions={[view('t1', { description: 'Venda X' })]} />)
    expect(screen.getByText('Venda X')).toBeTruthy()
  })
})

describe('whenTransactionsViewHasError_thenRetryIsOffered', () => {
  it('mostra erro e botão de retry', () => {
    const onRetry = vi.fn()
    renderWithI18n(<TransactionsView transactions={[]} error="falha" onRetry={onRetry} />)
    expect(screen.getByText('falha')).toBeTruthy()
    expect(screen.getByRole('button', { name: /tentar novamente/i })).toBeTruthy()
  })
})
