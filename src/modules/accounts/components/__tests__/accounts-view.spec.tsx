// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AccountsView } from '../AccountsView'
import { TreasuryHeader } from '../TreasuryHeader'
import { SummaryHeader } from '../SummaryHeader'
import { AccountCard } from '../AccountCard'
import { AccountsGrid } from '../AccountsGrid'
import { StatementTable } from '../StatementTable'
import { ImportOfxModal } from '../ImportOfxModal'
import { TransferModal } from '../TransferModal'
import { DeleteAccountDialog } from '../DeleteAccountDialog'
import { formatCentsBRL } from '@/lib/utils'
import type {
  AccountViewItem,
  StatementTxView,
  TreasuryMetricsCents,
} from '../../model/view-model'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

function account(id: string, name: string): AccountViewItem {
  return {
    id,
    nickname: name,
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
}

const ACCOUNT = account('acc-1', 'Conta Um')
const ACCOUNTS = [ACCOUNT, account('acc-2', 'Conta Dois')]

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
  vi.useRealTimers()
  await i18n.changeLanguage('pt-BR')
})

describe('whenStatementsModeHasNoAccounts_thenDedicatedEmptyStateIsRendered', () => {
  it('mostra empty + hint + CTA e esconde tabela vazia e summary duplicado', () => {
    renderWithI18n(<AccountsView accounts={[]} />)

    expect(screen.getByText(i18n.t('accounts.empty'))).toBeTruthy()
    expect(screen.getByText(i18n.t('accounts.emptyHint'))).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('accounts.grid.add') })).toBeTruthy()
    expect(screen.queryByText(i18n.t('accounts.statement.empty'))).toBeNull()
    expect(screen.queryByText(i18n.t('accounts.summary.generalBalance'))).toBeNull()
  })
})

describe('whenStoreIsEmptyWithoutError_thenNoDemoBadgeIsShown', () => {
  it('empty honesto sem selo demo e sem persistência', () => {
    renderWithI18n(<AccountsView accounts={[]} />)

    expect(screen.queryByText(i18n.t('accounts.demoBadge'))).toBeNull()
    expect(screen.getByText(i18n.t('accounts.empty'))).toBeTruthy()
  })
})

describe('whenGridModeHasNoAccounts_thenGridEmptyStateIsPreserved', () => {
  it('mantém o empty-state do grid com CTA', () => {
    renderWithI18n(<AccountsView accounts={[]} initialViewMode="grid" />)

    expect(screen.getByText(i18n.t('accounts.empty'))).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('accounts.grid.add') })).toBeTruthy()
  })
})

describe('whenGridHasNoAccounts_thenRealEmptyStateIsRendered', () => {
  it('mostra título, dica e CTA de cadastro', () => {
    renderWithI18n(
      <AccountsGrid accounts={[]} selectedAccountId="" onSelectAccount={() => {}} onOpenNewAccount={() => {}} />,
    )

    expect(screen.getByText(i18n.t('accounts.empty'))).toBeTruthy()
    expect(screen.getByText(i18n.t('accounts.emptyHint'))).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('accounts.grid.add') })).toBeTruthy()
    expect(screen.queryByText(i18n.t('accounts.grid.all'))).toBeNull()
  })
})

describe('whenToolbarIsRendered_thenToggleBesideTitleAndChipsGroupSticky', () => {
  it('toggle na linha do título; grupo dos chips com role=group, aria-label e sticky', () => {
    const { container } = renderWithI18n(<AccountsView accounts={[ACCOUNT]} />)

    const toggle = container.querySelector('[data-testid="accounts-toggle"]')!
    expect(toggle.textContent).toContain(i18n.t('accounts.viewStatements'))
    expect(toggle.parentElement!.querySelector('h1')).toBeTruthy()

    const group = screen.getByRole('group', { name: i18n.t('accounts.toolbar.viewsAndAccounts') })
    expect(group.className).toContain('sticky')
    expect(group.textContent).toContain(i18n.t('accounts.selector.consolidated'))
  })
})

describe('whenMetricsHaveNoProjections_thenCardFillsTheColumn', () => {
  it('card consolidado não é limitado por max-w-xl inerte (A-S5)', () => {
    renderWithI18n(
      <TreasuryHeader
        metrics={ZERO_METRICS}
        accountsCount={0}
        onOpenNewAccount={() => {}}
        onOpenTransfer={() => {}}
        onOpenImportOFX={() => {}}
      />,
    )

    const card = screen.getByText(i18n.t('accounts.metrics.consolidated')).closest('div.rounded-2xl')
    expect(card?.className).not.toContain('max-w-xl')
    expect(card?.className).toContain('border-border/80')
  })
})

describe('whenAccountsCountIsSingular_thenLabelUsesPluralAwareKey', () => {
  it('usa singular para 1 conta', () => {
    renderWithI18n(
      <TreasuryHeader
        metrics={ZERO_METRICS}
        accountsCount={1}
        onOpenNewAccount={() => {}}
        onOpenTransfer={() => {}}
        onOpenImportOFX={() => {}}
      />,
    )

    expect(screen.getByText('1 conta')).toBeTruthy()
  })

  it('usa plural para 3 contas', () => {
    renderWithI18n(
      <TreasuryHeader
        metrics={ZERO_METRICS}
        accountsCount={3}
        onOpenNewAccount={() => {}}
        onOpenTransfer={() => {}}
        onOpenImportOFX={() => {}}
      />,
    )

    expect(screen.getByText('3 contas')).toBeTruthy()
  })

  it('usa variante sem número para zero', () => {
    renderWithI18n(
      <TreasuryHeader
        metrics={ZERO_METRICS}
        accountsCount={0}
        onOpenNewAccount={() => {}}
        onOpenTransfer={() => {}}
        onOpenImportOFX={() => {}}
      />,
    )

    expect(screen.getByText('Nenhuma conta')).toBeTruthy()
    expect(screen.queryByText('0 conta')).toBeNull()
  })
})

describe('whenProjectionDataIsAbsent_thenFabricatedKpisAreHidden', () => {
  it('cabeçalho de tesouraria não exibe entradas/saídas/rendimento zerados', () => {
    renderWithI18n(
      <TreasuryHeader
        metrics={{ ...ZERO_METRICS, totalConsolidatedBalanceCents: 100000, totalAvailableBalanceCents: 100000 }}
        accountsCount={1}
        onOpenNewAccount={() => {}}
        onOpenTransfer={() => {}}
        onOpenImportOFX={() => {}}
      />,
    )

    expect(screen.queryByText(i18n.t('accounts.metrics.inflow15'))).toBeNull()
    expect(screen.queryByText(i18n.t('accounts.metrics.outflow15'))).toBeNull()
    expect(screen.queryByText(i18n.t('accounts.metrics.yield'))).toBeNull()
    expect(screen.getByText(i18n.t('accounts.metrics.projectionsUnavailable'))).toBeTruthy()
  })

  it('cabeçalho consolidado não exibe a projeção de 15 dias', () => {
    renderWithI18n(
      <SummaryHeader account={ACCOUNT} metrics={ZERO_METRICS} onOpenTransfer={() => {}} onOpenImportOFX={() => {}} />,
    )

    expect(screen.queryByText(i18n.t('accounts.summary.projection'))).toBeNull()
  })
})

describe('whenBankLineIsRendered_thenTextComesFromTranslations', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('card usa chave i18n (en-US) em vez de literal Ag/Cc', () => {
    renderWithI18n(<AccountCard account={ACCOUNT} isSelected={false} onSelect={() => {}} />)
    expect(screen.getByText('Branch: 0001 • Acct: 12345-0')).toBeTruthy()
  })

  it('cabeçalho consolidado usa a mesma chave i18n', () => {
    renderWithI18n(
      <SummaryHeader account={ACCOUNT} metrics={ZERO_METRICS} onOpenTransfer={() => {}} onOpenImportOFX={() => {}} />,
    )
    expect(screen.getByText('Branch: 0001 • Acct: 12345-0')).toBeTruthy()
  })

  it('modal OFX usa a mesma chave i18n na conta selecionada', () => {
    renderWithI18n(
      <ImportOfxModal open onOpenChange={() => {}} accounts={[ACCOUNT]} initialAccountId="acc-1" />,
    )
    // C-S4: Select do design system — o valor exibido carrega a mesma chave.
    const trigger = screen.getByRole('combobox', { name: i18n.t('accounts.ofx.accountLabel') })
    expect(trigger.textContent).toContain('Branch: 0001 • Acct: 12345-0')
  })
})

describe('whenSyncIsTriggered_thenExactlyOneToastIsShown', () => {
  beforeEach(() => {
    toastMocks.success.mockReset()
    toastMocks.info.mockReset()
    toastMocks.error.mockReset()
    vi.useFakeTimers()
  })

  it('sync global e sync da conta delegam o toast ao dono da tela', () => {
    renderWithI18n(<AccountsView accounts={[ACCOUNT]} />)

    act(() => {
      screen.getByLabelText(i18n.t('accounts.metrics.syncTitle')).click()
    })
    act(() => {
      vi.advanceTimersByTime(1200)
    })

    expect(toastMocks.success).not.toHaveBeenCalled()
    expect(toastMocks.info).toHaveBeenCalledTimes(1)
    expect(toastMocks.info).toHaveBeenCalledWith(i18n.t('accounts.syncUnavailable'))
  })
})

const PENDING_TX: StatementTxView = {
  id: 'tx-pending',
  accountId: 'acc-1',
  date: '2026-11-13',
  description: 'Pagamento de fornecedor',
  category: 'Fornecedores',
  amountCents: 45000,
  type: 'debit',
  reconciliationStatus: 'pending',
}

describe('whenStatementRowIsReconciled_thenOwnerEmitsSingleHonestToast', () => {
  beforeEach(() => {
    toastMocks.success.mockReset()
    toastMocks.info.mockReset()
    toastMocks.error.mockReset()
  })

  it('não afirma conciliação persistida e não duplica o aviso', () => {
    renderWithI18n(<AccountsView accounts={[ACCOUNT]} transactions={[PENDING_TX]} />)

    act(() => {
      screen.getByRole('button', { name: i18n.t('accounts.statement.reconcile') }).click()
    })

    expect(toastMocks.success).not.toHaveBeenCalled()
    expect(toastMocks.info).toHaveBeenCalledTimes(1)
    expect(toastMocks.info).toHaveBeenCalledWith(i18n.t('accounts.reconcileUnavailable'))
  })

  it('tabela sozinha não emite toast de sucesso (dono da tela decide)', () => {
    const onReconcile = vi.fn()
    renderWithI18n(<StatementTable account={null} transactions={[PENDING_TX]} onReconcileTransaction={onReconcile} />)

    act(() => {
      screen.getByRole('button', { name: i18n.t('accounts.statement.reconcile') }).click()
    })

    expect(onReconcile).toHaveBeenCalledWith('tx-pending')
    expect(toastMocks.success).not.toHaveBeenCalled()
    expect(toastMocks.info).not.toHaveBeenCalled()
  })
})

describe('whenTransferModalIsReopened_thenInitialStateIsRebuilt', () => {
  it('recalcula origem/destino a partir do initialSourceAccountId novo', () => {
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <TransferModal open={false} onOpenChange={() => {}} accounts={ACCOUNTS} initialSourceAccountId="acc-1" onExecuteTransfer={async () => true} />
      </I18nextProvider>,
    )

    // C-S4: Select do design system (Radix) — valor visível no trigger.
    const source = () =>
      screen.getByRole('combobox', { name: i18n.t('accounts.sourceAccount') })

    rerender(
      <I18nextProvider i18n={i18n}>
        <TransferModal open onOpenChange={() => {}} accounts={ACCOUNTS} initialSourceAccountId="acc-1" onExecuteTransfer={async () => true} />
      </I18nextProvider>,
    )
    expect(source().textContent).toContain('Conta Um')

    rerender(
      <I18nextProvider i18n={i18n}>
        <TransferModal open={false} onOpenChange={() => {}} accounts={ACCOUNTS} initialSourceAccountId="acc-1" onExecuteTransfer={async () => true} />
      </I18nextProvider>,
    )
    rerender(
      <I18nextProvider i18n={i18n}>
        <TransferModal open onOpenChange={() => {}} accounts={ACCOUNTS} initialSourceAccountId="acc-2" onExecuteTransfer={async () => true} />
      </I18nextProvider>,
    )

    expect(source().textContent).toContain('Conta Dois')
  })
})

describe('whenOFXModalIsReopened_thenSelectedAccountFollowsInitialAccountId', () => {
  it('não congela a conta da primeira abertura', () => {
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <ImportOfxModal open={false} onOpenChange={() => {}} accounts={ACCOUNTS} initialAccountId="acc-1" />
      </I18nextProvider>,
    )

    const select = () =>
      screen.getByRole('combobox', { name: i18n.t('accounts.ofx.accountLabel') })

    rerender(
      <I18nextProvider i18n={i18n}>
        <ImportOfxModal open onOpenChange={() => {}} accounts={ACCOUNTS} initialAccountId="acc-2" />
      </I18nextProvider>,
    )

    expect(select().textContent).toContain('Conta Dois')
  })
})

const money = (cents: number) => formatCentsBRL(cents).replace(/\u00a0/g, ' ')

function tx(overrides: Partial<StatementTxView>): StatementTxView {
  return {
    id: 'tx-1',
    accountId: 'acc-1',
    date: '2026-11-13',
    description: 'Lançamento',
    category: 'Fornecedores',
    amountCents: 0,
    type: 'credit',
    reconciliationStatus: 'reconciled',
    ...overrides,
  }
}

describe('whenStatementHasDebitAndCredit_thenSignIsRenderedFromType', () => {
  it('débito sai com sinal negativo (mesmo com amountCents positivo)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StatementTable account={null} transactions={[tx({ id: 'out', type: 'debit', amountCents: 345080, description: 'Saída' })]} />
      </I18nextProvider>,
    )

    expect(screen.getByText(`- ${money(345080)}`)).toBeTruthy()
  })

  it('crédito sai com sinal positivo', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StatementTable account={null} transactions={[tx({ id: 'in', type: 'credit', amountCents: -1425000, description: 'Entrada' })]} />
      </I18nextProvider>,
    )

    expect(screen.getByText(`+ ${money(1425000)}`)).toBeTruthy()
  })
})

describe('whenDeleteDialogHasNoAccountName_thenItNeverAnnouncesEmptyQuotes', () => {
  it('usa a variante sem nome em vez de Excluir ""?', () => {
    renderWithI18n(
      <DeleteAccountDialog open accountName="" error={null} isDeleting={false} onOpenChange={() => {}} onConfirm={() => {}} />,
    )

    expect(screen.queryByText(/""/)).toBeNull()
    expect(screen.getByText(i18n.t('accounts.deleteHintFallback'))).toBeTruthy()
  })

  it('mantém o nome da conta quando existe', () => {
    renderWithI18n(
      <DeleteAccountDialog open accountName="Conta Um" error={null} isDeleting={false} onOpenChange={() => {}} onConfirm={() => {}} />,
    )

    expect(screen.getByText(i18n.t('accounts.deleteHint', { name: 'Conta Um' }))).toBeTruthy()
  })
})
