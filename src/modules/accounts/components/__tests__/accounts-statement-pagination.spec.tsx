// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
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

function tx(index: number): StatementTxView {
  return {
    id: `tx-${index}`,
    accountId: 'acc-1',
    date: '2026-11-13',
    description: `Lançamento ${index}`,
    category: 'Fornecedores',
    amountCents: 1000 * index,
    type: index % 2 === 0 ? 'credit' : 'debit',
    reconciliationStatus: 'reconciled',
  }
}

const THIRTY = Array.from({ length: 30 }, (_, i) => tx(i + 1))

function renderTable(transactions: StatementTxView[]) {
  return render(
    <I18nextProvider i18n={i18n}>
      <StatementTable account={ACCOUNT} transactions={transactions} />
    </I18nextProvider>,
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenStatementHasManyRows_thenFooterCountsAndPaginates', () => {
  it('mostra contador e limita a primeira página a 25 linhas (B-A9)', () => {
    const { container } = renderTable(THIRTY)

    const rows = container.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(25)

    expect(
      screen.getByText(
        i18n.t('accounts.statement.showing', { from: 1, to: 25, total: 30 }),
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(i18n.t('accounts.statement.pageOf', { page: 1, pages: 2 })),
    ).toBeTruthy()
  })

  it('avança e volta página com anterior/próxima (B-A9)', async () => {
    const user = userEvent.setup()
    const { container } = renderTable(THIRTY)

    const prev = screen.getByRole('button', { name: i18n.t('accounts.statement.prevPage') })
    const next = screen.getByRole('button', { name: i18n.t('accounts.statement.nextPage') })
    expect(prev.hasAttribute('disabled')).toBe(true)
    expect(next.hasAttribute('disabled')).toBe(false)

    await user.click(next)

    expect(container.querySelectorAll('tbody tr')).toHaveLength(5)
    expect(
      screen.getByText(
        i18n.t('accounts.statement.showing', { from: 26, to: 30, total: 30 }),
      ),
    ).toBeTruthy()
    expect(next.hasAttribute('disabled')).toBe(true)

    await user.click(screen.getByRole('button', { name: i18n.t('accounts.statement.prevPage') }))
    expect(container.querySelectorAll('tbody tr')).toHaveLength(25)
  })

  it('filtro que reduz o resultado volta para a primeira página (B-A9)', async () => {
    const user = userEvent.setup()
    renderTable(THIRTY)

    await user.click(screen.getByRole('button', { name: i18n.t('accounts.statement.nextPage') }))
    expect(screen.getByText(i18n.t('accounts.statement.pageOf', { page: 2, pages: 2 }))).toBeTruthy()

    await user.click(screen.getByRole('radio', { name: i18n.t('accounts.statement.inflow') }))

    expect(
      screen.getByTestId('statement-page-indicator').textContent,
    ).toContain(i18n.t('accounts.statement.pageOf', { page: 1, pages: 1 }))
  })

  it('sem linhas não exibe rodapé de paginação (B-A9)', () => {
    renderTable([])

    expect(screen.queryByTestId('statement-page-summary')).toBeNull()
    expect(screen.getByText(i18n.t('accounts.statement.empty'))).toBeTruthy()
  })
})

describe('whenStatementPaginationIsRendered_thenCountersUseTabularNums', () => {
  it('contador e indicador usam tabular-nums (B-A9)', () => {
    renderTable(THIRTY)

    const summary = screen.getByTestId('statement-page-summary')
    expect(summary.className).toContain('tabular-nums')
    const footer = within(summary.parentElement as HTMLElement)
    expect(footer.getByTestId('statement-page-indicator').className).toContain('tabular-nums')
  })
})
