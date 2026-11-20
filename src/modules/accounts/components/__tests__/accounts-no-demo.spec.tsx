// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AccountsView } from '../AccountsView'
import { StatementTable } from '../StatementTable'
import { demoStatementForAccounts } from '../../model/accounts.adapter'
import type { AccountViewItem, StatementTxView } from '../../model/view-model'

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

function renderWithI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  toastMocks.success.mockReset()
  toastMocks.info.mockReset()
  toastMocks.error.mockReset()
  await i18n.changeLanguage('pt-BR')
})

describe('whenDemoStatementIsRequested_thenEmptyStatementIsReturned', () => {
  it('conta nova abre extrato vazio: sem DEMO-1/DEMO-2, sem linhas', () => {
    const rows = demoStatementForAccounts([ACCOUNT], i18n.t, new Date(2026, 10, 13))

    expect(rows).toEqual([])
  })
})

describe('whenNewAccountHasNoTransactions_thenHonestEmptyStateIsRendered', () => {
  it('extrato de conta nova mostra empty honesto e zero rastro demo (PT)', () => {
    renderWithI18n(<AccountsView accounts={[ACCOUNT]} transactions={[]} />)

    expect(screen.getByText(i18n.t('accounts.statement.empty'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('accounts.demoBadge'))).toBeNull()
    expect(document.body.textContent).not.toMatch(/DEMO-\d/)
    expect(document.body.textContent).not.toMatch(/Demonstração/)
  })

  it('extrato de conta nova mostra empty honesto e zero rastro demo (EN)', async () => {
    await i18n.changeLanguage('en-US')
    renderWithI18n(<AccountsView accounts={[ACCOUNT]} transactions={[]} />)

    expect(screen.getByText(i18n.t('accounts.statement.empty'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('accounts.demoBadge'))).toBeNull()
    expect(document.body.textContent).not.toMatch(/DEMO-\d/)
    expect(document.body.textContent).not.toMatch(/Demo(nstração)?/)
  })
})

describe('whenStatementHasNoData_thenExportIsDisabledWithHonestReason', () => {
  it('botões CSV/OFX desabilitados no vazio, sem toast fantasma', () => {
    const onExport = vi.fn()
    renderWithI18n(<StatementTable account={ACCOUNT} transactions={[]} onExportStatement={onExport} />)

    const csv = screen.getByRole('button', { name: 'CSV' })
    const ofx = screen.getByRole('button', { name: 'OFX' })
    expect(csv.hasAttribute('disabled')).toBe(true)
    expect(ofx.hasAttribute('disabled')).toBe(true)

    act(() => {
      csv.click()
      ofx.click()
    })
    expect(onExport).not.toHaveBeenCalled()
    expect(toastMocks.info).not.toHaveBeenCalled()
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  it('com dado real, export permanece habilitado e delega ao dono', () => {
    const onExport = vi.fn()
    const rows: StatementTxView[] = [
      {
        id: 'tx-1',
        accountId: 'acc-1',
        date: '2026-11-13',
        description: 'Recebimento PIX',
        category: 'Vendas',
        amountCents: 1425000,
        type: 'credit',
        reconciliationStatus: 'reconciled',
      },
    ]
    renderWithI18n(<StatementTable account={ACCOUNT} transactions={rows} onExportStatement={onExport} />)

    const csv = screen.getByRole('button', { name: 'CSV' })
    expect(csv.hasAttribute('disabled')).toBe(false)
    act(() => {
      csv.click()
    })
    expect(onExport).toHaveBeenCalledWith('csv')
  })
})

describe('whenStatementHasNoData_thenNoReconcileActionIsOffered', () => {
  it('vazio honesto não oferece conciliar nem afirma gravação', () => {
    const onReconcile = vi.fn()
    renderWithI18n(
      <StatementTable account={ACCOUNT} transactions={[]} onReconcileTransaction={onReconcile} />,
    )

    expect(screen.queryByRole('button', { name: i18n.t('accounts.statement.reconcile') })).toBeNull()
    expect(screen.getByText(i18n.t('accounts.statement.empty'))).toBeTruthy()
    expect(onReconcile).not.toHaveBeenCalled()
  })
})

describe('whenSyncHasNoConnection_thenToastIsHonestWithoutDemoTrace', () => {
  it('sync indisponível não menciona demonstração nem afirma gravação', () => {
    renderWithI18n(<AccountsView accounts={[ACCOUNT]} transactions={[]} />)

    act(() => {
      screen.getByLabelText(i18n.t('accounts.metrics.syncTitle')).click()
    })

    expect(toastMocks.success).not.toHaveBeenCalled()
    expect(toastMocks.info).toHaveBeenCalledTimes(1)
    const message = String(toastMocks.info.mock.calls[0]?.[0] ?? '')
    expect(message).not.toMatch(/Demonstração|Demo/i)
    expect(message).toBe(i18n.t('accounts.syncUnavailable'))
  })
})
