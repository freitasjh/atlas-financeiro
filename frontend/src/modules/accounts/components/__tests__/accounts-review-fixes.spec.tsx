// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AccountsView } from '../AccountsView'
import { StatementTable } from '../StatementTable'
import { AccountCard } from '../AccountCard'
import { NewAccountModal } from '../NewAccountModal'
import { TreasuryHeader } from '../TreasuryHeader'
import { BankAccountStatementTable } from '@/components/shadcn/bank-accounts/bank-account-statement-table'
import type { AccountViewItem, StatementTxView, TreasuryMetricsCents } from '../../model/view-model'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }))

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

const ISO_DATE = '2026-11-13'
const DISPLAY_DATE = '13/11/2026'

const TX: StatementTxView = {
  id: 'tx-1',
  accountId: 'acc-1',
  date: ISO_DATE,
  description: 'Recebimento PIX',
  category: 'Vendas',
  amountCents: 1425000,
  type: 'credit',
  reconciliationStatus: 'pending',
}

const ZERO_METRICS: TreasuryMetricsCents = {
  totalConsolidatedBalanceCents: 0,
  totalAvailableBalanceCents: 0,
  totalBlockedBalanceCents: 0,
  projectedInflow15DaysCents: 0,
  projectedOutflow15DaysCents: 0,
  monthYieldCDICents: 0,
  yieldPercentageCDI: 0,
  hasProjections: false,
}

function renderWithI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenStatementReceivesIsoDate_thenUiShowsBrazilianDate', () => {
  it('datas ISO do store aparecem como dd/MM/yyyy (D1)', () => {
    renderWithI18n(<StatementTable account={ACCOUNT} transactions={[TX]} />)

    expect(screen.getByText(DISPLAY_DATE)).toBeTruthy()
    expect(screen.queryByText(ISO_DATE)).toBeNull()
  })

  it('data já formatada não é reformatada (idempotente)', () => {
    renderWithI18n(
      <StatementTable account={ACCOUNT} transactions={[{ ...TX, date: DISPLAY_DATE }]} />,
    )

    expect(screen.getByText(DISPLAY_DATE)).toBeTruthy()
  })
})

describe('whenTransactionCountExceedsLoadedRows_thenFooterIsHonest', () => {
  it('declara carregados x total real do store (D2)', () => {
    renderWithI18n(
      <StatementTable account={ACCOUNT} transactions={[TX]} totalCount={1250} />,
    )

    const summary = screen.getByTestId('statement-page-summary')
    expect(summary.textContent).toContain(i18n.t('accounts.statement.showing', { from: 1, to: 1, total: 1 }))
    expect(summary.textContent).toContain(
      i18n.t('accounts.statement.showingCap', { loaded: 1, total: 1250 }),
    )
  })

  it('sem teto atingido não menciona total do store (D2)', () => {
    renderWithI18n(
      <StatementTable account={ACCOUNT} transactions={[TX]} totalCount={1} />,
    )

    const summary = screen.getByTestId('statement-page-summary')
    expect(summary.textContent).not.toContain(
      i18n.t('accounts.statement.showingCap', { loaded: 1, total: 1 }),
    )
  })
})

describe('whenThereAreZeroAccounts_thenOnlyOneCreationCtaIsOffered', () => {
  it('modo extrato: só o CTA do empty state, sem SelectorBar (D3)', () => {
    renderWithI18n(<AccountsView accounts={[]} />)

    expect(screen.queryByTestId('accounts-chips')).toBeNull()
    expect(screen.queryByRole('button', { name: i18n.t('accounts.selector.newAccount') })).toBeNull()
    expect(screen.getAllByRole('button', { name: i18n.t('accounts.grid.add') })).toHaveLength(1)
  })

  it('modo carteira: só o CTA do empty state, sem CTA do header (D3)', () => {
    renderWithI18n(<AccountsView accounts={[]} initialViewMode="grid" />)

    expect(screen.queryByRole('button', { name: i18n.t('accounts.metrics.newAccount') })).toBeNull()
    expect(screen.getAllByRole('button', { name: i18n.t('accounts.grid.add') })).toHaveLength(1)
  })

  it('com contas, os dois modos continuam oferecendo criação (D3)', () => {
    const statements = renderWithI18n(<AccountsView accounts={[ACCOUNT]} />)
    expect(screen.getByRole('button', { name: i18n.t('accounts.selector.newAccount') })).toBeTruthy()
    statements.unmount()

    renderWithI18n(<AccountsView accounts={[ACCOUNT]} initialViewMode="grid" />)
    expect(screen.getByRole('button', { name: i18n.t('accounts.metrics.newAccount') })).toBeTruthy()
  })
})

describe('whenSmallControlsRender_thenTouchTargetIsAtLeast44px', () => {
  it('menu do AccountCard (A1)', () => {
    renderWithI18n(<AccountCard account={ACCOUNT} isSelected={false} onSelect={() => {}} />)

    const menu = screen.getByRole('button', { name: i18n.t('accounts.card.actionsAria', { name: ACCOUNT.nickname }) })
    expect(menu.className).toContain('min-h-11')
    expect(menu.className).toContain('min-w-11')
    expect(menu.className).toContain('sm:h-8')
    expect(menu.className).toContain('sm:min-w-8')
  })

  it('Conciliar do extrato da rota (A1)', () => {
    renderWithI18n(<StatementTable account={ACCOUNT} transactions={[TX]} />)

    const reconcile = screen.getByRole('button', { name: i18n.t('accounts.statement.reconcile') })
    expect(reconcile.className).toContain('min-h-11')
    expect(reconcile.className).toContain('min-w-11')
    expect(reconcile.className).toContain('sm:h-8')
    expect(reconcile.className).toContain('sm:min-w-8')
  })

  it('Conciliar do extrato da vitrine (A1)', () => {
    renderWithI18n(
      <BankAccountStatementTable
        account={null}
        transactions={[
          {
            id: 't1',
            accountId: 'acc-1',
            date: DISPLAY_DATE,
            description: 'Pagamento pendente',
            category: 'Fornecedores',
            amount: 50,
            type: 'debit',
            reconciliationStatus: 'pending',
          },
        ]}
      />,
    )

    const reconcile = screen.getByRole('button', { name: i18n.t('accounts.statement.reconcile') })
    expect(reconcile.className).toContain('min-h-11')
    expect(reconcile.className).toContain('min-w-11')
    expect(reconcile.className).toContain('sm:min-w-8')
  })

  it('chevrons do carrossel de instituições (A1)', () => {
    renderWithI18n(<NewAccountModal open onOpenChange={() => {}} onSubmit={() => {}} />)

    for (const name of [i18n.t('accounts.carouselPrev'), i18n.t('accounts.carouselNext')]) {
      const button = screen.getByRole('button', { name })
      expect(button.className).toContain('min-h-11')
      expect(button.className).toContain('min-w-11')
      expect(button.className).toContain('sm:min-w-8')
    }
  })

  it('header da tesouraria mantém CTA de criação com contas (A1/D3)', () => {
    renderWithI18n(
      <TreasuryHeader
        metrics={ZERO_METRICS}
        accountsCount={2}
        onOpenNewAccount={() => {}}
        onOpenTransfer={() => {}}
        onOpenImportOFX={() => {}}
      />,
    )

    expect(screen.getByRole('button', { name: i18n.t('accounts.metrics.newAccount') })).toBeTruthy()
  })
})

describe('whenBalanceErrorIsShown_thenItLeavesTheCurrencyPrefixBox', () => {
  it('mensagem do saldo fica fora do wrapper do prefixo R$ (A2)', async () => {
    const user = userEvent.setup()
    renderWithI18n(<NewAccountModal open onOpenChange={() => {}} onSubmit={() => {}} />)

    await user.type(screen.getByLabelText(/Apelido da conta/), 'Conta X')
    // 20 dígitos: a máscara preserva e o parser recusa (> 15 dígitos) → erro real.
    await user.type(screen.getByLabelText(i18n.t('accounts.initialBalance')), '99999999999999999999')
    await user.click(screen.getByRole('button', { name: i18n.t('accounts.saveBankAccount') }))

    const balance = screen.getByLabelText(i18n.t('accounts.initialBalance')) as HTMLInputElement
    const describedBy = balance.getAttribute('aria-describedby')
    expect(describedBy).toBe('new-account-balance-error')

    const message = document.getElementById('new-account-balance-error')
    expect(message).not.toBeNull()

    const prefixBox = balance.parentElement as HTMLElement
    expect(within(prefixBox).queryByRole('alert')).toBeNull()
    expect(prefixBox.contains(message)).toBe(false)
    expect(message?.parentElement?.contains(balance)).toBe(true)
  })
})
