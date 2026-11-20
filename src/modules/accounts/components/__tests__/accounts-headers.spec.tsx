// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AccountsView } from '../AccountsView'
import { TreasuryHeader } from '../TreasuryHeader'
import { SummaryHeader } from '../SummaryHeader'
import type { AccountViewItem, TreasuryMetricsCents } from '../../model/view-model'

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

describe('whenTreasuryHeaderRenders_thenItIsASectionNotAPageHeader', () => {
  it('não repete o h1/subtítulo da página (A-C1)', () => {
    const { container } = renderWithI18n(
      <TreasuryHeader
        metrics={ZERO_METRICS}
        accountsCount={1}
        onOpenNewAccount={() => {}}
        onOpenTransfer={() => {}}
        onOpenImportOFX={() => {}}
      />,
    )

    expect(container.querySelectorAll('h1')).toHaveLength(0)
    expect(container.textContent).not.toContain(i18n.t('accounts.templateTitle'))
    expect(container.textContent).not.toContain(i18n.t('accounts.metrics.subtitle'))
    expect(screen.getByText('1 conta')).toBeTruthy()
  })
})

describe('whenTreasuryHeaderRenders_thenOpenFinanceComesFromI18n', () => {
  it('rótulo sincronizar/Open Finance vem das chaves (pt-BR)', () => {
    renderWithI18n(
      <TreasuryHeader
        metrics={ZERO_METRICS}
        accountsCount={1}
        onOpenNewAccount={() => {}}
        onOpenTransfer={() => {}}
        onOpenImportOFX={() => {}}
      />,
    )

    const sync = screen.getByRole('button', { name: i18n.t('accounts.metrics.syncTitle') })
    const expected = `${i18n.t('accounts.metrics.sync')} ${i18n.t('accounts.openFinance')}`
    expect(sync.textContent?.replace(/\s+/g, ' ').trim()).toBe(expected)
  })

  it('rótulo sincronizar/Open Finance vem das chaves (en-US)', async () => {
    await i18n.changeLanguage('en-US')
    renderWithI18n(
      <TreasuryHeader
        metrics={ZERO_METRICS}
        accountsCount={1}
        onOpenNewAccount={() => {}}
        onOpenTransfer={() => {}}
        onOpenImportOFX={() => {}}
      />,
    )

    const sync = screen.getByRole('button', { name: i18n.t('accounts.metrics.syncTitle') })
    const expected = `${i18n.t('accounts.metrics.sync')} ${i18n.t('accounts.openFinance')}`
    expect(sync.textContent?.replace(/\s+/g, ' ').trim()).toBe(expected)
    expect(expected).toBe('Sync Open Finance')
  })
})

describe('whenTransferCtaRenders_thenItUsesActionToken', () => {
  it('CTA de transferência usa bg-primary, não cor de dado (A-C2)', () => {
    renderWithI18n(
      <SummaryHeader account={ACCOUNT} metrics={ZERO_METRICS} onOpenTransfer={() => {}} onOpenImportOFX={() => {}} />,
    )

    const cta = screen.getByRole('button', { name: i18n.t('accounts.summary.transferCta') })
    expect(cta.className).toContain('bg-primary')
    expect(cta.className).toContain('text-primary-foreground')
    expect(cta.className).not.toContain('bg-emerald-600')
    expect(cta.className).not.toContain('text-white')
  })
})

describe('whenGridModeRenders_thenOnlyOneNewAccountActionExists', () => {
  it('CTA única no header de tesouraria e tile informativo (A-A11)', () => {
    renderWithI18n(<AccountsView accounts={[ACCOUNT]} initialViewMode="grid" />)

    const primaryCtas = screen.getAllByRole('button', { name: i18n.t('accounts.metrics.newAccount') })
    expect(primaryCtas).toHaveLength(1)

    expect(screen.queryByTestId('accounts-chips')).toBeNull()
    expect(screen.queryByRole('button', { name: i18n.t('accounts.grid.add') })).toBeNull()
    expect(screen.getByText(i18n.t('accounts.grid.add'))).toBeTruthy()
    expect(screen.getByText(i18n.t('accounts.grid.addHint'))).toBeTruthy()
  })

  it('tile informativo não é acionável por clique (sem role=button)', () => {
    renderWithI18n(<AccountsView accounts={[ACCOUNT]} initialViewMode="grid" />)

    const tile = screen.getByText(i18n.t('accounts.grid.add')).closest('div')
    expect(tile).not.toBeNull()
    expect(tile?.getAttribute('role')).toBeNull()
    expect(tile?.className ?? '').not.toContain('cursor-pointer')
  })
})

describe('whenModeSectionsRender_thenTheyUseFlexGapInsteadOfSpaceY', () => {
  it('extrato e carteira usam flex flex-col gap-4 (A-S6)', () => {
    const statements = renderWithI18n(<AccountsView accounts={[ACCOUNT]} />)
    const statementsSection = statements.container.querySelector('[data-testid="accounts-mode-section"]')
    expect(statementsSection?.className).toContain('flex')
    expect(statementsSection?.className).toContain('flex-col')
    expect(statementsSection?.className).toContain('gap-4')
    expect(statements.container.querySelector('.space-y-4')).toBeNull()
    cleanup()

    const grid = renderWithI18n(<AccountsView accounts={[ACCOUNT]} initialViewMode="grid" />)
    const gridSection = grid.container.querySelector('[data-testid="accounts-mode-section"]')
    expect(gridSection?.className).toContain('flex')
    expect(gridSection?.className).toContain('flex-col')
    expect(gridSection?.className).toContain('gap-4')
    expect(grid.container.querySelector('.space-y-4')).toBeNull()
  })
})

describe('whenToggleChangesMode_thenItUsesPillToggleWithRadioSemantics', () => {
  it('alternador usa PillToggle (radiogroup) e preserva o modo (A-A7)', async () => {
    const user = userEvent.setup()
    renderWithI18n(<AccountsView accounts={[ACCOUNT]} />)

    const wrapper = screen.getByTestId('accounts-toggle')
    const group = wrapper.querySelector('[role="radiogroup"]')
    expect(group).not.toBeNull()
    expect(group?.getAttribute('aria-label')).toBe(i18n.t('accounts.toolbar.viewMode'))

    const statementsItem = within(wrapper).getByRole('radio', {
      name: i18n.t('accounts.viewStatements'),
    })
    expect(statementsItem.getAttribute('aria-checked')).toBe('true')
    // Item ativo da primitiva: superfície de card + anel de borda.
    expect(statementsItem.className).toContain('bg-background')
    expect(statementsItem.className).toContain('text-foreground')
    expect(statementsItem.className).toContain('ring-1')
    expect(statementsItem.className).toContain('motion-reduce:transition-none')
    expect(statementsItem.className).not.toContain('bg-accent')

    await user.click(within(wrapper).getByRole('radio', { name: i18n.t('accounts.viewGrid') }))

    expect(screen.getByText(i18n.t('accounts.metrics.consolidated'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('accounts.statement.titleAll'))).toBeNull()
    expect(
      within(wrapper).getByRole('radio', { name: i18n.t('accounts.viewGrid') }).getAttribute('aria-checked'),
    ).toBe('true')
  })
})
