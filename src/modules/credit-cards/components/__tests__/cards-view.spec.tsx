// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { CardsView, type CardsViewProps } from '../CardsView'
import type { CardPurchaseSubmitInput } from '../CardPurchaseDialog'
import { DEFAULT_CARD_THEME, type CreditCardView } from '../../model/credit-card'
import type { InvoiceRow } from '../../service/credit-cards.service'
import type { ExpenseRow } from '@/components/shadcn/credit-card/card-expenses-table'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

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
    onPurchase: vi.fn(async () => {}),
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

describe('whenCardsViewRenders_thenArchetype2BlocksArePresent', () => {
  it('exibe seletor, veredito 3 colunas, MonthTabs, tabela e rodapé contador', () => {
    renderWithI18n(<CardsView {...baseProps()} />)

    expect(screen.getAllByText('Nubank Final 1234').length).toBeGreaterThan(0)
    expect(screen.getByText(i18n.t('cards.view.statements'))).toBeTruthy()
    expect(screen.getByText(i18n.t('cards.pay'))).toBeTruthy()
    expect(screen.getByText(i18n.t('cards.table.footer', { shown: 2, total: 2 }))).toBeTruthy()
    expect(screen.getByText(i18n.t('cards.table.detailHint'))).toBeTruthy()
  })

  it('total da fatura usa tabular-nums', () => {
    const { container } = renderWithI18n(<CardsView {...baseProps()} />)
    const totals = container.querySelectorAll('.tabular-nums')
    expect(totals.length).toBeGreaterThan(0)
  })
})

describe('whenNoCards_thenHonestEmptyState', () => {
  it('mostra empty + hint + CTA e esconde tabela', () => {
    renderWithI18n(<CardsView {...baseProps({ cards: [], selectedCardId: '', invoices: [], expenses: [] })} />)

    expect(screen.getByText(i18n.t('cards.empty'))).toBeTruthy()
    expect(screen.getByText(i18n.t('cards.emptyHint'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('cards.table.detailHint'))).toBeNull()
  })
})

describe('whenNoExpenses_thenCycleEmptyState', () => {
  it('mostra vazio do ciclo com hint', () => {
    renderWithI18n(<CardsView {...baseProps({ expenses: [] })} />)

    expect(screen.getByText(i18n.t('cards.transactions.empty'))).toBeTruthy()
    expect(screen.getByText(i18n.t('cards.transactions.emptyHint'))).toBeTruthy()
  })
})

describe('whenFilterMatchesNothing_thenNoResultsState', () => {
  it('mostra sem-resultados ao filtrar', () => {
    renderWithI18n(<CardsView {...baseProps({ expenses: [], expenseFilter: 'pending' })} />)

    expect(screen.getByText(i18n.t('cards.transactions.noResults'))).toBeTruthy()
  })
})

describe('whenTogglingToWallet_thenSelectionIsPreserved', () => {
  it('troca para carteira e mantém cartão selecionado', () => {
    const onSelectCard = vi.fn()
    renderWithI18n(<CardsView {...baseProps({ onSelectCard })} />)

    fireEvent.click(screen.getByRole('radio', { name: i18n.t('cards.view.walletCount', { count: 2 }) }))

    expect(screen.getAllByText('Nubank Final 1234').length).toBeGreaterThan(0)
    expect(screen.getByRole('radio', { name: i18n.t('cards.view.statements') })).toBeTruthy()
  })
})

describe('whenInvoiceIsPaid_thenPayIsDisabled', () => {
  it('desabilita CTA e exibe badge Paga', () => {
    renderWithI18n(
      <CardsView
        {...baseProps({
          invoices: [invoice('inv-paid', 'c-1', { status: 'paid', paid_cents: 120000 })],
        })}
      />,
    )

    expect(screen.getByRole('button', { name: i18n.t('cards.pay') })).toHaveProperty('disabled', true)
    expect(screen.getByText(i18n.t('cards.paid'))).toBeTruthy()
  })
})

describe('whenConsolidatedChipClicked_thenSelectionBecomesAggregated', () => {
  it("clicar consolidado chama onSelectCard('') sem fallback", () => {
    const onSelectCard = vi.fn()
    renderWithI18n(<CardsView {...baseProps({ onSelectCard })} />)

    fireEvent.click(screen.getByRole('button', { name: new RegExp(i18n.t('cards.selector.consolidated')) }))

    expect(onSelectCard).toHaveBeenCalledTimes(1)
    expect(onSelectCard).toHaveBeenCalledWith('')
  })

  it('modo consolidado exibe veredito agregado em vez do header do cartão', () => {
    renderWithI18n(<CardsView {...baseProps({ selectedCardId: '' })} />)

    expect(screen.getByTestId('cards-consolidated-verdict')).toBeTruthy()
    expect(screen.getAllByText(i18n.t('cards.selector.consolidated')).length).toBeGreaterThan(0)
  })

  it('modo consolidado usa título e rótulo global do veredito do template', () => {
    renderWithI18n(<CardsView {...baseProps({ selectedCardId: '' })} />)

    const verdict = screen.getByTestId('cards-consolidated-verdict')
    expect(within(verdict).getByText(i18n.t('cards.verdict.consolidatedTitle'))).toBeTruthy()
    expect(within(verdict).getByText(i18n.t('cards.verdict.totalLabel'))).toBeTruthy()
  })

  it('modo cartão exibe header do cartão e esconde veredito consolidado', () => {
    renderWithI18n(<CardsView {...baseProps({ selectedCardId: 'c-1' })} />)

    expect(screen.queryByTestId('cards-consolidated-verdict')).toBeNull()
    expect(screen.getAllByText('Nubank Final 1234').length).toBeGreaterThan(0)
  })
})

describe('whenCardsViewRenders_thenModeToggleIsAccessibleRadiogroup', () => {
  it('expõe radiogroup rotulado com 2 radios, aria-checked e roving tabindex', () => {
    renderWithI18n(<CardsView {...baseProps()} />)

    const group = screen.getByTestId('cards-view-toggle')
    expect(group.getAttribute('role')).toBe('radiogroup')
    expect(group.getAttribute('aria-label')).toBe(i18n.t('cards.view.toggleLabel'))

    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true')
    expect(radios[1]?.getAttribute('aria-checked')).toBe('false')
    expect(radios[0]?.tabIndex).toBe(0)
    expect(radios[1]?.tabIndex).toBe(-1)
  })

  it('rótulo da carteira traz a contagem de cartões via chave i18n dedicada', () => {
    renderWithI18n(<CardsView {...baseProps()} />)

    const group = screen.getByTestId('cards-view-toggle')
    expect(
      within(group).getByRole('radio', { name: i18n.t('cards.view.walletCount', { count: 2 }) }),
    ).toBeTruthy()
  })
})

describe('whenModeToggleKeyboard_thenArrowsMoveAndCheck', () => {
  it('seta direita checa Carteira e foca; seta esquerda volta a Faturas', () => {
    renderWithI18n(<CardsView {...baseProps()} />)

    const group = screen.getByTestId('cards-view-toggle')
    const statements = within(group).getByRole('radio', { name: i18n.t('cards.view.statements') })
    const wallet = within(group).getByRole('radio', {
      name: i18n.t('cards.view.walletCount', { count: 2 }),
    })

    statements.focus()
    fireEvent.keyDown(statements, { key: 'ArrowRight' })
    expect(wallet.getAttribute('aria-checked')).toBe('true')
    expect(statements.getAttribute('aria-checked')).toBe('false')
    expect(document.activeElement).toBe(wallet)
    expect(wallet.tabIndex).toBe(0)
    expect(statements.tabIndex).toBe(-1)

    fireEvent.keyDown(wallet, { key: 'ArrowLeft' })
    expect(statements.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(statements)
  })

  it('setas verticais movem e checam; Space/Enter checam no elemento focado', () => {
    renderWithI18n(<CardsView {...baseProps()} />)

    const group = screen.getByTestId('cards-view-toggle')
    const statements = within(group).getByRole('radio', { name: i18n.t('cards.view.statements') })
    const wallet = within(group).getByRole('radio', {
      name: i18n.t('cards.view.walletCount', { count: 2 }),
    })

    statements.focus()
    fireEvent.keyDown(statements, { key: 'ArrowDown' })
    expect(wallet.getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(wallet, { key: 'ArrowUp' })
    expect(statements.getAttribute('aria-checked')).toBe('true')

    wallet.focus()
    fireEvent.keyDown(wallet, { key: ' ' })
    expect(wallet.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(wallet)

    statements.focus()
    fireEvent.keyDown(statements, { key: 'Enter' })
    expect(statements.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(statements)

    const checked = within(group).getAllByRole('radio').filter((radio) => radio.getAttribute('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
    expect(checked[0]?.tabIndex).toBe(0)
  })

  it('Tab sai do radiogroup e foca o próximo controle fora dele (sem armadilha)', async () => {
    const user = userEvent.setup()
    renderWithI18n(<CardsView {...baseProps()} />)

    const group = screen.getByTestId('cards-view-toggle')
    const checked = within(group)
      .getAllByRole('radio')
      .find((radio) => radio.getAttribute('aria-checked') === 'true')
    expect(checked).toBeTruthy()
    checked?.focus()
    expect(document.activeElement).toBe(checked)

    const nextFocusable = screen.getByRole('button', { name: i18n.t('cards.new') })
    expect(nextFocusable).toBeTruthy()

    await user.tab()

    expect(group.contains(document.activeElement)).toBe(false)
    expect(document.activeElement).toBe(nextFocusable)
  })
})

describe('whenSwitchingMode_thenSelectionAndPeriodArePreserved', () => {
  it('toggle não altera cartão nem período selecionados', () => {
    const onSelectCard = vi.fn()
    const onPeriodChange = vi.fn()
    renderWithI18n(<CardsView {...baseProps({ onSelectCard, onPeriodChange })} />)

    const group = screen.getByTestId('cards-view-toggle')
    const statements = within(group).getByRole('radio', { name: i18n.t('cards.view.statements') })
    const wallet = within(group).getByRole('radio', {
      name: i18n.t('cards.view.walletCount', { count: 2 }),
    })

    fireEvent.click(wallet)
    expect(onSelectCard).not.toHaveBeenCalled()
    expect(onPeriodChange).not.toHaveBeenCalled()
    fireEvent.click(statements)
    expect(onSelectCard).not.toHaveBeenCalled()
    expect(onPeriodChange).not.toHaveBeenCalled()

    const selectedTab = screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')
    expect(selectedTab).toBeTruthy()
    expect(screen.getAllByText('Nubank Final 1234').length).toBeGreaterThan(0)
  })
})

describe('whenLocaleChanges_thenHeaderUsesTranslations', () => {
  it('título e subtítulo vêm de t() em PT e em EN', async () => {
    renderWithI18n(<CardsView {...baseProps()} />)

    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toContain(i18n.t('cards.title'))
    expect(screen.getByText(i18n.t('cards.subtitle'))).toBeTruthy()

    await act(async () => {
      await i18n.changeLanguage('en-US')
    })

    expect(heading.textContent).toContain('Credit Cards & Invoices')
    expect(screen.getByText('Track limits, transactions and pay your invoices.')).toBeTruthy()
    expect(heading.textContent).not.toContain('Cartões')
  })
})

describe('whenViewportIsNarrow_thenToggleCarriesShortLabels', () => {
  it('PT: rótulos curtos e completos coexistem no toggle (mitigação 375px; medição real no E2E F4)', () => {
    renderWithI18n(<CardsView {...baseProps()} />)

    const group = screen.getByTestId('cards-view-toggle')
    expect(within(group).getByText(i18n.t('cards.view.statementsShort'))).toBeTruthy()
    expect(within(group).getByText(i18n.t('cards.view.walletShort'))).toBeTruthy()
    expect(within(group).getByText(i18n.t('cards.view.statements'))).toBeTruthy()
    expect(within(group).getByText(i18n.t('cards.view.walletCount', { count: 2 }))).toBeTruthy()
  })

  it('EN: rótulos curtos e completos coexistem no toggle (mitigação 375px; medição real no E2E F4)', async () => {
    await act(async () => {
      await i18n.changeLanguage('en-US')
    })
    renderWithI18n(<CardsView {...baseProps()} />)

    const group = screen.getByTestId('cards-view-toggle')
    expect(within(group).getByText(i18n.t('cards.view.statementsShort'))).toBeTruthy()
    expect(within(group).getByText(i18n.t('cards.view.walletShort'))).toBeTruthy()
    expect(within(group).getByText(i18n.t('cards.view.statements'))).toBeTruthy()
    expect(within(group).getByText(i18n.t('cards.view.walletCount', { count: 2 }))).toBeTruthy()
  })
})

describe('whenNovaCompraIsSubmitted_thenOnPurchaseReceivesPayload', () => {
  it('gatilho da tabela abre o dialog e o submit propaga o payload', async () => {
    const user = userEvent.setup()
    const onPurchase = vi.fn(async (_input: CardPurchaseSubmitInput) => {})
    renderWithI18n(<CardsView {...baseProps({ onPurchase })} />)

    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: i18n.t('cards.transactions.newPurchase') }))
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.change(screen.getByLabelText(i18n.t('cards.installmentDescription')), {
      target: { value: 'Mercado' },
    })
    fireEvent.change(screen.getByLabelText(i18n.t('cards.installmentTotal')), {
      target: { value: '2500' },
    })
    fireEvent.change(screen.getByLabelText(i18n.t('cards.purchaseDate')), {
      target: { value: '2026-09-15' },
    })
    fireEvent.submit(
      screen.getByRole('button', { name: i18n.t('cards.installmentSubmit') }).closest('form') as HTMLFormElement,
    )

    await waitFor(() => expect(onPurchase).toHaveBeenCalledTimes(1))
    expect(onPurchase.mock.calls[0][0]).toMatchObject({
      description: 'Mercado',
      totalCents: 2500,
      date: '2026-09-15',
      categoryId: null,
      installments: 1,
    })
  })
})
