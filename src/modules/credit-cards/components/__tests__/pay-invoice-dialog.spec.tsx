// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { PayInvoiceDialog } from '../PayInvoiceDialog'
import type { InvoiceRow } from '../../service/credit-cards.service'

const INVOICE: InvoiceRow = {
  id: 'inv-1',
  user_id: 'u-1',
  credit_card_id: 'c-1',
  period_start: '2026-09-11',
  period_end: '2026-10-10',
  due_date: '2026-10-20',
  status: 'closed',
  total_cents: 120000,
  paid_cents: 20000,
  paid_at: null,
  created_at: '2026-09-11T00:00:00Z',
}

const ACCOUNTS = [{ id: 'acc-1', name: 'Conta Corrente', balanceCents: 900000 as number | null }]

function renderWithI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenPayDialogOpens_thenRemainingIsShownTabular', () => {
  it('exibe valor restante com tabular-nums', () => {
    renderWithI18n(
      <PayInvoiceDialog
        open
        onOpenChange={() => {}}
        invoice={INVOICE}
        remainingCents={100000}
        accounts={ACCOUNTS}
        defaultAccountId="acc-1"
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText(i18n.t('cards.payRemaining'))).toBeTruthy()
    expect(document.body.querySelector('.tabular-nums')).toBeTruthy()
  })
})

describe('whenPayConfirmed_thenAccountAndDateAreSent', () => {
  it('envia conta + data sem montar valor no cliente', async () => {
    const onConfirm = vi.fn(async () => {})
    renderWithI18n(
      <PayInvoiceDialog
        open
        onOpenChange={() => {}}
        invoice={INVOICE}
        remainingCents={100000}
        accounts={ACCOUNTS}
        defaultAccountId="acc-1"
        onConfirm={onConfirm}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: i18n.t('cards.transfer.confirm') }))

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })
    const [accountId, date] = onConfirm.mock.calls[0] as unknown as [string, string]
    expect(accountId).toBe('acc-1')
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('whenPayFails_thenCauseAndFixAreShown', () => {
  it('exibe causa + correção para nothing-to-pay', () => {
    renderWithI18n(
      <PayInvoiceDialog
        open
        onOpenChange={() => {}}
        invoice={INVOICE}
        remainingCents={0}
        accounts={ACCOUNTS}
        defaultAccountId="acc-1"
        serverError="invoice-nothing-to-pay"
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText(i18n.t('cards.transfer.nothingToPay'))).toBeTruthy()
  })

  it('exibe causa + correção para already-paid', () => {
    renderWithI18n(
      <PayInvoiceDialog
        open
        onOpenChange={() => {}}
        invoice={INVOICE}
        remainingCents={0}
        accounts={ACCOUNTS}
        defaultAccountId="acc-1"
        serverError="invoice-already-paid"
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText(i18n.t('cards.transfer.alreadyPaid'))).toBeTruthy()
  })
})
