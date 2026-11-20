// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { StatementTable } from '../StatementTable'
import type { AccountViewItem, StatementTxView } from '../../model/view-model'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

const ACCOUNT: AccountViewItem = {
  id: 'acc-1',
  nickname: 'Conta Um',
  institution: 'itau',
  type: 'checking',
  agency: '0001',
  accountNumber: '12345',
  accountDigit: '0',
  currentBalanceCents: 100000,
  reconciledBalanceCents: 100000,
  blockedBalanceCents: 0,
  isDefault: false,
  connectionStatus: 'connected',
}

const TX: StatementTxView = {
  id: 'tx-1',
  accountId: 'acc-1',
  date: '2026-11-13',
  description: 'Recebimento PIX',
  category: 'Vendas',
  amountCents: 1425000,
  type: 'credit',
  reconciliationStatus: 'reconciled',
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenStatementIsLoading_thenSkeletonReplacesFakeEmpty', () => {
  it('marca aria-busy e não afirma extrato vazio (B-A12)', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <StatementTable account={ACCOUNT} transactions={[]} isLoading />
      </I18nextProvider>,
    )

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.getByTestId('statement-skeleton')).toBeTruthy()
    expect(screen.queryByText(i18n.t('accounts.statement.empty'))).toBeNull()
    expect(screen.getByText(i18n.t('accounts.statement.loading'))).toBeTruthy()
    expect(screen.queryByTestId('statement-page-summary')).toBeNull()
  })

  it('loading vence quando há linhas antigas em cache (B-A12)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StatementTable account={ACCOUNT} transactions={[TX]} isLoading />
      </I18nextProvider>,
    )

    expect(screen.getByTestId('statement-skeleton')).toBeTruthy()
    expect(screen.queryByText('Recebimento PIX')).toBeNull()
  })
})

describe('whenStatementHasError_thenAlertIsHonestAndRetryable', () => {
  it('exibe alert com erro real e ação de retry (B-A12)', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <StatementTable
          account={ACCOUNT}
          transactions={[]}
          hasError
          onRetryTransactions={onRetry}
        />
      </I18nextProvider>,
    )

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(i18n.t('accounts.statement.loadError'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('accounts.statement.empty'))).toBeNull()

    await user.click(screen.getByRole('button', { name: i18n.t('accounts.statement.retry') }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('erro não esconde o cabeçalho do extrato (B-A12)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StatementTable account={ACCOUNT} transactions={[]} hasError onRetryTransactions={() => {}} />
      </I18nextProvider>,
    )

    expect(screen.getByText(i18n.t('accounts.statement.titleOne', { name: ACCOUNT.nickname }))).toBeTruthy()
  })
})
