// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AccountsView } from '../AccountsView'
import { StatementTable } from '../StatementTable'
import type { AccountViewItem, StatementTxView } from '../../model/view-model'

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

describe('whenStatementHasNoRowsAtAll_thenEmptyStateSpeaksOfNoData', () => {
  it('transactions vazio mostra mensagem de "sem dados" (C-S8)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StatementTable account={ACCOUNT} transactions={[]} />
      </I18nextProvider>,
    )

    expect(screen.getByText(i18n.t('accounts.statement.empty'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('accounts.statement.emptyFiltered'))).toBeNull()
  })
})

describe('whenFiltersExcludeEveryRow_thenEmptyStateSpeaksOfFilters', () => {
  it('busca sem resultado mostra mensagem de filtro, não de base vazia (C-S8)', async () => {
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={i18n}>
        <StatementTable account={ACCOUNT} transactions={[TX]} />
      </I18nextProvider>,
    )

    await user.type(
      screen.getByRole('searchbox', { name: i18n.t('accounts.statement.searchAria') }),
      'inexistente-xyz',
    )

    expect(screen.getByText(i18n.t('accounts.statement.emptyFiltered'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('accounts.statement.empty'))).toBeNull()
  })
})

describe('whenBothViewModesRender_thenLayoutContractHoldsForEach', () => {
  it('modo extrato: selector + resumo + extrato, sem grade (C-S10)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <AccountsView accounts={[ACCOUNT]} transactions={[TX]} />
      </I18nextProvider>,
    )

    expect(screen.getByTestId('accounts-chips')).toBeTruthy()
    expect(screen.getByText(i18n.t('accounts.summary.consolidatedView'))).toBeTruthy()
    expect(screen.getByText(i18n.t('accounts.statement.titleAll'))).toBeTruthy()
    expect(screen.queryByTestId('accounts-grid-add-hint')).toBeNull()
  })

  it('modo carteira: header de tesouraria + grade, sem selector nem extrato (C-S10)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <AccountsView accounts={[ACCOUNT]} initialViewMode="grid" />
      </I18nextProvider>,
    )

    expect(screen.getByText(i18n.t('accounts.metrics.consolidated'))).toBeTruthy()
    expect(screen.getByTestId('accounts-grid-add-hint')).toBeTruthy()
    expect(screen.queryByTestId('accounts-chips')).toBeNull()
    expect(screen.queryByText(i18n.t('accounts.statement.titleAll'))).toBeNull()
  })
})
