// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { CardsView, type CardsViewProps } from '../CardsView'
import { DEFAULT_CARD_THEME, type CreditCardView } from '../../model/credit-card'
import type { InvoiceRow } from '../../service/credit-cards.service'
import type { ExpenseRow } from '@/components/shadcn/credit-card/card-expenses-table'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

// P3.1 — fluxos CRUD + troca cartão/mês + pagamento + bloqueio paid (TDD).

function card(id: string, nickname: string): CreditCardView {
  return {
    id,
    nickname,
    brand: 'visa',
    theme: DEFAULT_CARD_THEME,
    accountId: 'acc-1',
    limitCents: 500000,
    closingDay: 10,
    dueDay: 20,
  }
}

function invoice(id: string, cardId: string, overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id,
    user_id: 'u-1',
    credit_card_id: cardId,
    period_start: '2026-09-11',
    period_end: '2026-10-10',
    due_date: '2026-10-20',
    status: 'closed',
    total_cents: 120000,
    paid_cents: 20000,
    paid_at: null,
    created_at: '2026-09-11T00:00:00Z',
    ...overrides,
  }
}

function expense(id: string, overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id,
    description: `Compra ${id}`,
    date: '2026-09-15',
    amountCents: 10000,
    installmentLabel: null,
    categoryName: null,
    pending: false,
    isTransfer: false,
    ...overrides,
  }
}

const CARDS = [card('c-1', 'Nubank Final 1234'), card('c-2', 'Itaú Final 5678')]
const ACCOUNTS = [{ id: 'acc-1', name: 'Conta Corrente', balanceCents: 900000 }]

function baseProps(overrides: Partial<CardsViewProps> = {}): CardsViewProps {
  const invoices = [invoice('inv-1', 'c-1')]
  return {
    cards: CARDS,
    selectedCardId: 'c-1',
    invoices,
    invoicesByCard: { 'c-1': invoices, 'c-2': [] },
    periodCode: '2026-09',
    periodCodes: ['2026-09'],
    invoiceTotals: { '2026-09': 120000 },
    expenses: [expense('e-1'), expense('e-2')],
    expenseFilter: 'all',
    search: '',
    accounts: ACCOUNTS,
    totalOpenCents: 100000,
    archivedIds: [],
    principalCardId: null,
    onSelectCard: vi.fn(),
    onPeriodChange: vi.fn(),
    onFilterChange: vi.fn(),
    onSearchChange: vi.fn(),
    onExport: vi.fn(),
    onCreateCard: vi.fn(async () => {}),
    onUpdateCard: vi.fn(async () => {}),
    onDeleteCard: vi.fn(async () => {}),
    onArchiveCard: vi.fn(),
    onSetPrincipal: vi.fn(),
    onPayInvoice: vi.fn(async () => {}),
    ...overrides,
  }
}

function renderWithI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

function dialog(): HTMLElement {
  const dialogs = document.querySelectorAll('[role="dialog"]')
  return dialogs[dialogs.length - 1] as HTMLElement
}

afterEach(async () => {
  cleanup()
  vi.clearAllMocks()
  await i18n.changeLanguage('pt-BR')
})

describe('whenCardOrMonthSwitches_thenFilterPillStaysSelected', () => {
  it('trocar de cartão não reseta o filtro (só chama onSelectCard)', () => {
    const onSelectCard = vi.fn()
    const onFilterChange = vi.fn()
    renderWithI18n(
      <CardsView
        {...baseProps({ expenseFilter: 'pending', onSelectCard, onFilterChange, periodCodes: ['2026-09', '2026-08'] })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Itaú Final 5678/ }))

    expect(onSelectCard).toHaveBeenCalledWith('c-2')
    expect(onFilterChange).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: i18n.t('cards.table.pending') }).getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  it('trocar de mês não reseta o filtro (só chama onPeriodChange)', () => {
    const onPeriodChange = vi.fn()
    const onFilterChange = vi.fn()
    renderWithI18n(
      <CardsView
        {...baseProps({
        expenseFilter: 'installments',
        onPeriodChange,
        onFilterChange,
        periodCodes: ['2026-09', '2026-08'],
        invoiceTotals: { '2026-09': 120000, '2026-08': 50000 },
      })}
      />
    )

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    fireEvent.click(tabs[1])

    expect(onPeriodChange).toHaveBeenCalledWith('2026-08')
    expect(onFilterChange).not.toHaveBeenCalled()
    expect(
      screen.getByRole('radio', { name: i18n.t('cards.table.installments') }).getAttribute('aria-checked'),
    ).toBe('true')
  })
})

describe('whenPaySucceeds_thenDialogClosesWithAccountAndDate', () => {
  it.each([
    ['parcial (resta 100000)', 20000, 100000],
    ['total (resta 120000)', 0, 120000],
  ])('pagamento %s envia conta + data sem montar valor', async (_label, paidCents, remaining) => {
    const onPayInvoice = vi.fn(async () => {})
    renderWithI18n(
      <CardsView
        {...baseProps({
        invoices: [invoice('inv-1', 'c-1', { paid_cents: paidCents })],
        onPayInvoice,
      })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: i18n.t('cards.pay') }))
    expect(
      within(dialog()).getByText(i18n.t('cards.payRemaining')),
    ).toBeTruthy()

    fireEvent.click(within(dialog()).getByRole('button', { name: i18n.t('cards.transfer.confirm') }))

    await waitFor(() => expect(onPayInvoice).toHaveBeenCalledTimes(1))
    const [accountId, date] = onPayInvoice.mock.calls[0] as unknown as [string, string]
    expect(accountId).toBe('acc-1')
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(remaining).toBe(120000 - paidCents)
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  })
})

describe('whenPayFails_thenCauseStaysVisible', () => {
  it.each([
    ['invoice-nothing-to-pay', 'cards.transfer.nothingToPay'],
    ['invoice-already-paid', 'cards.transfer.alreadyPaid'],
  ])('erro %s exibe causa + correção sem fechar', async (code, key) => {
    const onPayInvoice = vi.fn(async () => {
      throw new Error(code)
    })
    renderWithI18n(<CardsView {...baseProps({ onPayInvoice })} />)

    fireEvent.click(screen.getByRole('button', { name: i18n.t('cards.pay') }))
    fireEvent.click(within(dialog()).getByRole('button', { name: i18n.t('cards.transfer.confirm') }))

    await waitFor(() => {
      expect(within(dialog()).getByText(i18n.t(key))).toBeTruthy()
    })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})

describe('whenInvoiceStatusVaries_thenPayLocksOnlyOnPaid', () => {
  it.each([
    ['open', false],
    ['closed', false],
    ['partial', false],
    ['paid', true],
  ])('status %s → pay disabled=%s', (status, disabled) => {
    cleanup()
    renderWithI18n(
      <CardsView
        {...baseProps({ invoices: [invoice('inv-1', 'c-1', { status: status as InvoiceRow['status'] })] })}
      />
    )
    expect(screen.getByRole('button', { name: i18n.t('cards.pay') })).toHaveProperty('disabled', disabled)
  })
})

describe('whenEditConfirmed_thenUpdateCarriesIdAndPatch', () => {
  it('wallet → Editar → Atualizar chama onUpdateCard com patch sem brand', async () => {
    const onUpdateCard = vi.fn(async () => {})
    renderWithI18n(<CardsView {...baseProps({ onUpdateCard, initialViewMode: 'wallet' })} />)

    fireEvent.click(screen.getAllByRole('button', { name: i18n.t('cards.edit') })[0])
    expect(within(dialog()).getByDisplayValue('Nubank Final 1234')).toBeTruthy()

    fireEvent.click(within(dialog()).getByRole('button', { name: i18n.t('cards.update') }))

    await waitFor(() => expect(onUpdateCard).toHaveBeenCalledTimes(1))
    const [id, patch] = onUpdateCard.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(id).toBe('c-1')
    expect(patch).toMatchObject({ name: 'Nubank Final 1234', limit_cents: 500000 })
    expect(patch).not.toHaveProperty('brand')
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  })
})

describe('whenDeleteSucceeds_thenDialogCloses', () => {
  it('wallet → Excluir → confirmar chama onDeleteCard e fecha', async () => {
    const onDeleteCard = vi.fn(async () => {})
    renderWithI18n(<CardsView {...baseProps({ onDeleteCard, initialViewMode: 'wallet' })} />)

    fireEvent.click(screen.getAllByRole('button', { name: i18n.t('cards.remove') })[0])
    expect(within(dialog()).getByText(i18n.t('cards.removeConfirm'))).toBeTruthy()

    const confirm = within(dialog()).getByRole('button', { name: i18n.t('cards.remove') })
    fireEvent.click(confirm)

    await waitFor(() => expect(onDeleteCard).toHaveBeenCalledWith('c-1'))
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  })
})

describe('whenDeleteBlockedByHistory_thenArchiveIsOfferedAndHides', () => {
  it('card-has-history → arquivar chama onArchiveCard + toast', async () => {
    const onDeleteCard = vi.fn(async () => {
      throw new Error('card-has-history')
    })
    const onArchiveCard = vi.fn()
    renderWithI18n(<CardsView {...baseProps({ onDeleteCard, onArchiveCard, initialViewMode: 'wallet' })} />)

    fireEvent.click(screen.getAllByRole('button', { name: i18n.t('cards.remove') })[0])
    fireEvent.click(within(dialog()).getByRole('button', { name: i18n.t('cards.remove') }))

    await waitFor(() => {
      expect(within(dialog()).getByText(i18n.t('cards.removeBlocked'))).toBeTruthy()
    })
    fireEvent.click(within(dialog()).getByRole('button', { name: i18n.t('cards.archive.action') }))

    expect(onArchiveCard).toHaveBeenCalledWith('c-1')
    expect(toastMocks.success).toHaveBeenCalledWith(i18n.t('cards.archive.done'))
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  })

  it('cartão arquivado some do seletor sem apagar histórico', () => {
    renderWithI18n(<CardsView {...baseProps({ archivedIds: ['c-2'] })} />)

    expect(screen.getAllByText('Nubank Final 1234').length).toBeGreaterThan(0)
    expect(screen.queryByText('Itaú Final 5678')).toBeNull()
  })
})

describe('whenCreateOpens_thenDialogValidatesBeforeSubmit', () => {
  it('Novo cartão abre o diálogo; vazio bloqueia com erro de nome', async () => {
    const onCreateCard = vi.fn(async () => {})
    renderWithI18n(<CardsView {...baseProps({ onCreateCard })} />)

    fireEvent.click(screen.getByRole('button', { name: i18n.t('cards.new') }))

    expect(within(dialog()).getByText(i18n.t('cards.new'))).toBeTruthy()
    fireEvent.click(within(dialog()).getByRole('button', { name: i18n.t('cards.create') }))

    await waitFor(() => {
      expect(within(dialog()).getByText(i18n.t('cards.nameError'))).toBeTruthy()
    })
    expect(onCreateCard).not.toHaveBeenCalled()
  })
})
