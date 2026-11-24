// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import ptBR from '@/i18n/messages/pt-BR'
import enUS from '@/i18n/messages/en-US'
import { formatCentsBRL } from '@/lib/utils'
import { CardsView, deriveConsolidatedVerdict, type CardsViewProps } from '../CardsView'
import { DEFAULT_CARD_THEME, displayDueDate, type CreditCardView } from '../../model/credit-card'
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
    period_end: '2026-10-08',
    due_date: '2026-10-20',
    status: 'closed',
    total_cents: 120000,
    paid_cents: 20000,
    paid_at: null,
    created_at: '2026-09-11T00:00:00Z',
    ...overrides,
  }
}

function expense(id: string): ExpenseRow {
  return {
    id,
    description: `Compra ${id}`,
    date: '2026-09-15',
    amountCents: 10000,
    installmentLabel: null,
    categoryName: null,
    pending: false,
    isTransfer: false,
  }
}

const CARDS = [card('c-1', 'Nubank Final 1234'), card('c-2', 'Itaú Final 5678')]
const ACCOUNTS = [{ id: 'acc-1', name: 'Conta Corrente', balanceCents: 900000 }]

function baseInvoices(): InvoiceRow[] {
  return [
    invoice('inv-1', 'c-1'),
    invoice('inv-2', 'c-2', {
      period_end: '2026-10-10',
      due_date: '2026-10-18',
      status: 'open',
      total_cents: 10000,
      paid_cents: 0,
    }),
  ]
}

function baseProps(overrides: Partial<CardsViewProps> = {}): CardsViewProps {
  return {
    cards: CARDS,
    selectedCardId: '',
    invoices: baseInvoices(),
    invoicesByCard: { 'c-1': [invoice('inv-1', 'c-1')], 'c-2': [] },
    periodCode: '2026-09',
    periodCodes: ['2026-09'],
    invoiceTotals: { '2026-09': 130000 },
    expenses: [expense('e-1')],
    expenseFilter: 'all',
    search: '',
    accounts: ACCOUNTS,
    totalOpenCents: 110000,
    totalLimitCents: 1000000,
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

function renderView(overrides: Partial<CardsViewProps> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <CardsView {...baseProps(overrides)} />
    </I18nextProvider>,
  )
}

function verdictCard() {
  return within(screen.getByTestId('cards-consolidated-verdict'))
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(i18n.language, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(
    new Date(`${iso}T12:00:00`),
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenConsolidatedVerdictRenders_thenEveryReferenceElementIsPresent', () => {
  it('badge, título, subtítulo global, valor, fechamento e vencimento', () => {
    renderView()

    const card = verdictCard()
    expect(card.getByText(i18n.t('cards.status.open'))).toBeTruthy()
    expect(card.getByText(i18n.t('cards.verdict.consolidatedTitle'))).toBeTruthy()
    expect(card.getByText(i18n.t('cards.verdict.totalLabel'))).toBeTruthy()
    expect(screen.getByTestId('cards-consolidated-verdict').textContent).toContain(formatCentsBRL(110000))

    const closing = formatDate('2026-10-10')
    const due = formatDate(displayDueDate('2026-10-18').effective)
    const rootText = screen.getByTestId('cards-consolidated-verdict').textContent
    expect(rootText).toContain(i18n.t('cards.verdict.closingDate'))
    expect(rootText).toContain(closing)
    expect(rootText).toContain(i18n.t('cards.verdict.nextDueDate'))
    expect(rootText).toContain(due)
  })

  it('painel de limite com valor disponível, barra ARIA e rodapé', () => {
    renderView()

    const card = verdictCard()
    expect(card.getByText(i18n.t('cards.limitGauge.available'))).toBeTruthy()
    expect(screen.getByTestId('cards-consolidated-verdict').textContent).toContain(formatCentsBRL(890000))

    const bar = card.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('11')
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    expect(bar.getAttribute('aria-valuetext')).toContain(i18n.t('cards.cardAria.limitUsed', { percent: 11 }).trim())
    expect(screen.getByTestId('cards-consolidated-verdict').textContent).toContain(
      i18n.t('cards.limitGauge.total'),
    )
    expect(screen.getByTestId('cards-consolidated-verdict').textContent).toContain(formatCentsBRL(1000000))
    expect(card.getByText(/11%/)).toBeTruthy()
  })

  it('chip de fim de semana é display-only e não altera a data persistida', () => {
    renderView()

    const shifted = verdictCard().getByTitle(
      i18n.t('cards.notice.weekendAria', { nominal: '2026-10-18', effective: '2026-10-19' }),
    )
    expect(shifted).toBeTruthy()
    expect(shifted.textContent).toBe(i18n.t('cards.notice.weekendChip'))
  })
})

describe('whenAggregatingConsolidatedVerdict_thenPureRulesHold', () => {
  it('fechamento usa max(period_end) entre faturas divergentes do mesmo ciclo', () => {
    const result = deriveConsolidatedVerdict(baseInvoices(), '2026-09', 110000, 1000000)
    expect(result.closingDate).toBe('2026-10-10')
  })

  it('vencimento usa menor effective entre não pagas', () => {
    const paidLate = invoice('inv-paid', 'c-1', { due_date: '2026-10-01', status: 'paid', paid_cents: 120000 })
    const result = deriveConsolidatedVerdict([...baseInvoices(), paidLate], '2026-09', 110000, 1000000)
    expect(result.dueDate?.effective).toBe(displayDueDate('2026-10-18').effective)
  })

  it('disponível = soma − aberto e percentual usa o aberto como numerador', () => {
    const result = deriveConsolidatedVerdict(baseInvoices(), '2026-09', 110000, 1000000)
    expect(result.availableCents).toBe(890000)
    expect(result.usedPercent).toBe(11)
  })

  it('parcial não infla o percentual com total da fatura', () => {
    const result = deriveConsolidatedVerdict(
      [invoice('inv-partial', 'c-1', { status: 'partial', total_cents: 120000, paid_cents: 20000 })],
      '2026-09',
      100000,
      500000,
    )
    expect(result.usedPercent).toBe(20)
    expect(result.availableCents).toBe(400000)
  })

  it('soma zero não gera NaN/Infinity', () => {
    const result = deriveConsolidatedVerdict(baseInvoices(), '2026-09', 110000, 0)
    expect(result.usedPercent).toBe(0)
    expect(result.availableCents).toBe(0)
  })

  it('sem faturas devolve datas nulas e marca vazio', () => {
    const result = deriveConsolidatedVerdict([], '2026-09', 0, 1000000)
    expect(result.closingDate).toBeNull()
    expect(result.dueDate).toBeNull()
    expect(result.hasInvoices).toBe(false)
  })

  it('tudo pago marca allPaid e mantém aberto zero', () => {
    const paid = [invoice('inv-paid', 'c-1', { status: 'paid', paid_cents: 120000 })]
    const result = deriveConsolidatedVerdict(paid, '2026-09', 0, 500000)
    expect(result.allPaid).toBe(true)
    expect(result.availableCents).toBe(500000)
  })
})

describe('whenEdgeCasesRender_thenHonestStatesWin', () => {
  it('totalLimitCents = 0 mostra indisponível sem barra nem NaN', () => {
    renderView({ totalLimitCents: 0 })

    const card = verdictCard()
    expect(card.getByText(i18n.t('cards.limitGauge.unavailable'))).toBeTruthy()
    expect(card.queryByRole('progressbar')).toBeNull()
    expect(screen.getByTestId('cards-consolidated-verdict').textContent).toContain(formatCentsBRL(110000))
    expect(screen.getByTestId('cards-consolidated-verdict').textContent).not.toContain('NaN')
  })

  it('sem faturas mostra badge vazio, travessão e CTAs desabilitados', () => {
    renderView({ invoices: [], totalOpenCents: 0 })

    const card = verdictCard()
    expect(card.getByText(i18n.t('cards.status.empty'))).toBeTruthy()
    const noDue = card.getByRole('img', { name: i18n.t('cards.invoice.noDueDate') })
    expect(noDue.textContent).toBe('—')
    expect(noDue.tagName).toBe('SPAN')
    expect(
      screen.getByTestId('cards-consolidated-verdict').querySelectorAll('strong[aria-label]'),
    ).toHaveLength(0)
    expect(screen.getByTestId('cards-consolidated-verdict').textContent).toContain(formatCentsBRL(0))
    for (const label of [i18n.t('cards.pay'), i18n.t('cards.exportCsv'), i18n.t('cards.viewStatement')]) {
      expect(card.getByRole('button', { name: label })).toHaveProperty('disabled', true)
    }
  })

  it('tudo pago mostra badge paga, nota allPaid e R$ 0', () => {
    renderView({
      invoices: [invoice('inv-paid', 'c-1', { status: 'paid', paid_cents: 120000 })],
      totalOpenCents: 0,
    })

    const card = verdictCard()
    expect(card.getByText(i18n.t('cards.status.paid'))).toBeTruthy()
    expect(card.getByText(i18n.t('cards.verdict.allPaid'))).toBeTruthy()
    expect(screen.getByTestId('cards-consolidated-verdict').textContent).toContain(formatCentsBRL(0))
  })
})

describe('whenConsolidatedCtasRender_thenAdr004SlotsAreHonest', () => {
  it('três CTAs com min-h-11, ícones Receipt/Download/List e sem QrCode', () => {
    renderView()
    const card = verdictCard()
    const root = screen.getByTestId('cards-consolidated-verdict')

    for (const label of [i18n.t('cards.pay'), i18n.t('cards.exportCsv'), i18n.t('cards.viewStatement')]) {
      const button = card.getByRole('button', { name: label })
      expect(button.className).toContain('min-h-11')
    }
    expect(root.querySelector('.lucide-receipt')).toBeTruthy()
    expect(root.querySelector('.lucide-download')).toBeTruthy()
    expect(root.querySelector('.lucide-list')).toBeTruthy()
    expect(root.querySelector('.lucide-qr-code')).toBeNull()
  })

  it('Pagar é desabilitado no consolidado com motivo visível e aria-describedby', () => {
    renderView()
    const card = verdictCard()
    const pay = card.getByRole('button', { name: i18n.t('cards.pay') })

    expect(pay).toHaveProperty('disabled', true)
    const hintId = pay.getAttribute('aria-describedby')
    expect(hintId).toBeTruthy()
    expect(card.getByText(i18n.t('cards.verdict.selectToPay')).id).toBe(hintId)
  })

  it('Exportar chama onExport e Ver lançamentos foca a âncora do extrato', () => {
    const onExport = vi.fn()
    renderView({ onExport })
    const card = verdictCard()

    fireEvent.click(card.getByRole('button', { name: i18n.t('cards.exportCsv') }))
    fireEvent.click(card.getByRole('button', { name: i18n.t('cards.viewStatement') }))

    expect(onExport).toHaveBeenCalledTimes(1)
    expect(document.activeElement?.getAttribute('data-testid')).toBe('cards-statement-anchor')
  })
})

describe('whenLocalesAreCompared_thenSixNewKeysAreComplete', () => {
  it('PT-BR e en-US definem as 6 chaves com texto honesto e sem rótulos proibidos', () => {
    const keys = [
      'consolidatedTitle',
      'totalLabel',
      'closingDate',
      'nextDueDate',
      'selectToPay',
      'allPaid',
    ] as const
    const forbidden = /Pix|Boleto|Linha Digit|Extrato PDF|pixCopyPaste|barcode|qrCodeUrl|MOCK_/i

    for (const key of keys) {
      expect(typeof ptBR.cards.verdict[key]).toBe('string')
      expect(typeof enUS.cards.verdict[key]).toBe('string')
      expect(ptBR.cards.verdict[key].length).toBeGreaterThan(0)
      expect(enUS.cards.verdict[key].length).toBeGreaterThan(0)
      expect(ptBR.cards.verdict[key]).not.toMatch(forbidden)
      expect(enUS.cards.verdict[key]).not.toMatch(forbidden)
    }
    expect(ptBR.cards.verdict.totalLabel).toContain('todos os ciclos')
    expect(enUS.cards.verdict.totalLabel).toContain('all cycles')
  })

  it('runtime troca PT→EN no título, subtítulo e motivo do pagamento', async () => {
    renderView()
    expect(verdictCard().getByText(i18n.t('cards.verdict.consolidatedTitle'))).toBeTruthy()

    await act(async () => {
      await i18n.changeLanguage('en-US')
    })

    expect(verdictCard().getByText('Consolidated Card Overview')).toBeTruthy()
    expect(verdictCard().getByText(/all cycles/)).toBeTruthy()
    expect(verdictCard().getByText('Select a card to pay')).toBeTruthy()
  })
})

describe('whenVerdictIsResponsive_thenLayoutContractsHold', () => {
  it('grid 5/4/3, colunas min-w-0, gap responsivo, raio e paddings alinhados ao layout dos cartões', () => {
    const { container } = renderView()
    const root = container.querySelector('[data-testid="cards-consolidated-verdict"]')
    const grid = root?.firstElementChild
    expect(grid?.className).toContain('grid-cols-1')
    expect(grid?.className).toContain('lg:grid-cols-12')
    expect(grid?.className).toContain('gap-6')
    expect(grid?.className).toContain('items-center')
    expect(root?.className).toContain('rounded-2xl')
    expect(root?.className).toContain('p-5')
    expect(root?.className).toContain('sm:p-6')

    const columns = grid?.children
    expect(columns?.[0]?.className).toContain('lg:col-span-5')
    expect(columns?.[1]?.className).toContain('lg:col-span-4')
    expect(columns?.[2]?.className).toContain('lg:col-span-3')
    for (const column of Array.from(columns ?? [])) {
      expect(column.className).toContain('min-w-0')
    }
  })

  it('barra respeita motion-reduce e texto longo usa truncate', () => {
    const { container } = renderView()
    const fill = container.querySelector('[role="progressbar"] > div')
    expect(fill?.className).toContain('motion-reduce:transition-none')
    expect(verdictCard().getByText(i18n.t('cards.verdict.consolidatedTitle')).className).toContain('truncate')
  })

  it('badge e título são irmãos na mesma linha, sem ícone Layers no título', () => {
    const { container } = renderView()
    const root = container.querySelector('[data-testid="cards-consolidated-verdict"]')
    const badge = verdictCard().getByText(i18n.t('cards.status.open'))
    const title = verdictCard().getByText(i18n.t('cards.verdict.consolidatedTitle'))

    expect(badge.parentElement).toBe(title.parentElement)
    expect(badge.parentElement?.className).toContain('items-center')
    expect(root?.querySelector('.lucide-layers')).toBeNull()
    expect(root?.querySelector('.lucide-calendar-days')).toBeTruthy()
  })

  it('um primário no topo, hint logo abaixo e 2 secundários lado a lado', () => {
    renderView()
    const pay = verdictCard().getByRole('button', { name: i18n.t('cards.pay') })
    const exportButton = verdictCard().getByRole('button', { name: i18n.t('cards.exportCsv') })
    const viewButton = verdictCard().getByRole('button', { name: i18n.t('cards.viewStatement') })
    const hint = verdictCard().getByText(i18n.t('cards.verdict.selectToPay'))

    expect(pay.parentElement).not.toBe(exportButton.parentElement)
    expect(exportButton.parentElement).toBe(viewButton.parentElement)
    expect(exportButton.parentElement?.className).toContain('grid-cols-2')
    expect(hint.previousElementSibling).toBe(pay)
    expect(hint.className).toContain('text-[11px]')
    expect(pay.getAttribute('aria-describedby')).toBe(hint.id)
  })

  it('datas curtas dd/mm/yyyy em uma linha e painel de limite sem quebra', () => {
    const { container } = renderView()
    const root = container.querySelector('[data-testid="cards-consolidated-verdict"]')
    const closing = verdictCard().getByText(formatDate('2026-10-10'))
    const dateRow = closing.parentElement?.parentElement

    expect(dateRow?.className).toContain('flex-wrap')
    expect(closing.parentElement?.className).toContain('whitespace-nowrap')

    const totalRow = Array.from(root?.querySelectorAll('span') ?? []).find(
      (span) => span.textContent?.includes(i18n.t('cards.limitGauge.total')) && span.querySelector('strong'),
    )
    expect(totalRow?.className).toContain('whitespace-nowrap')
    expect(verdictCard().getByText(/11%/).className).toContain('whitespace-nowrap')
    expect(verdictCard().getByRole('progressbar').className).toContain('h-2')
  })
})
