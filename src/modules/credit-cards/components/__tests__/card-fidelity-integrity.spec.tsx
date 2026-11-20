// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import i18n from '@/i18n'
import ptBR from '@/i18n/messages/pt-BR'
import enUS from '@/i18n/messages/en-US'
import { CardsView, type CardsViewProps } from '../CardsView'
import { DEFAULT_CARD_THEME, type CreditCardView } from '../../model/credit-card'
import type { InvoiceRow } from '../../service/credit-cards.service'
import type { ExpenseRow } from '@/components/shadcn/credit-card/card-expenses-table'

const MODULE_ROOT = join(__dirname, '..', '..')

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

function invoice(id: string, cardId: string): InvoiceRow {
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

function baseProps(overrides: Partial<CardsViewProps> = {}): CardsViewProps {
  const invoices = [invoice('inv-1', 'c-1')]
  return {
    cards: [card('c-1', 'Nubank Final 1234'), card('c-2', 'Itaú Final 5678')],
    selectedCardId: 'c-1',
    invoices,
    invoicesByCard: { 'c-1': invoices, 'c-2': [] },
    periodCode: '2026-09',
    periodCodes: ['2026-09'],
    invoiceTotals: { '2026-09': 120000 },
    expenses: [expense('e-1'), expense('e-2')],
    expenseFilter: 'all',
    search: '',
    accounts: [{ id: 'acc-1', name: 'Conta Corrente', balanceCents: 900000 }],
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

function renderView(overrides: Partial<CardsViewProps> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <CardsView {...baseProps(overrides)} />
    </I18nextProvider>,
  )
}

afterEach(() => {
  cleanup()
  void i18n.changeLanguage('pt-BR')
})

describe('whenCardsViewMounts_thenNewCardActionIsUnique', () => {
  it('exibe um único botão cards.new (somente no seletor)', () => {
    renderView()

    expect(screen.getAllByRole('button', { name: i18n.t('cards.new') })).toHaveLength(1)
  })
})

describe('whenExpenseTableRenders_thenDomainFiltersArePreservedAsPills', () => {
  it('mantém 3 filtros do domínio num PillToggle com aria-checked e foco/tamanho', () => {
    const onFilterChange = vi.fn()
    renderView({ onFilterChange })

    const group = screen.getByRole('radiogroup', { name: i18n.t('cards.transactions.title') })
    const pills = within(group).getAllByRole('radio')

    expect(pills).toHaveLength(3)
    expect(pills.map((pill) => pill.textContent)).toEqual([
      i18n.t('cards.table.all'),
      i18n.t('cards.table.pending'),
      i18n.t('cards.table.installments'),
    ])
    expect(pills.map((pill) => pill.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    for (const pill of pills) {
      expect(pill.className).toContain('h-6')
      expect(pill.className).toContain('focus-visible:ring-ring')
      expect(pill.className).toContain('sm:h-7')
    }

    fireEvent.click(pills[1] as HTMLElement)
    expect(onFilterChange).toHaveBeenCalledWith('pending')
  })
})

function moduleSources(): string[] {
  const files: string[] = []
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full)
    }
  }
  walk(MODULE_ROOT)
  return files
}

describe('whenVerdictCtaLabelsAreTranslated_thenPtBrAndEnUsMatchAdr004', () => {
  it('pt-BR e en-US definem os 3 rótulos com texto honesto', () => {
    expect(ptBR.cards.pay).toBe('Pagar fatura')
    expect(ptBR.cards.exportCsv).toBe('Exportar CSV')
    expect(ptBR.cards.viewStatement).toBe('Ver lançamentos')
    expect(enUS.cards.pay).toBe('Pay invoice')
    expect(enUS.cards.exportCsv).toBe('Export CSV')
    expect(enUS.cards.viewStatement).toBe('View transactions')

    const forbidden = /Pix|Boleto|Linha Digit|Extrato PDF|pixCopyPaste|barcode|qrCodeUrl|MOCK_/i
    expect(`${ptBR.cards.exportCsv} ${ptBR.cards.viewStatement}`).not.toMatch(forbidden)
    expect(`${enUS.cards.exportCsv} ${enUS.cards.viewStatement}`).not.toMatch(forbidden)
  })

  it('runtime i18n troca PT→EN nos rótulos dos CTAs', async () => {
    expect(i18n.t('cards.exportCsv')).toBe('Exportar CSV')
    expect(i18n.t('cards.viewStatement')).toBe('Ver lançamentos')

    await i18n.changeLanguage('en-US')

    expect(i18n.t('cards.exportCsv')).toBe('Export CSV')
    expect(i18n.t('cards.viewStatement')).toBe('View transactions')
  })
})

describe('whenVerdictCtaColumnIsWiredInCardsView_thenHandlersAreReal', () => {
  it('Exportar CSV no veredito chama o mesmo onExport da tabela', () => {
    const onExport = vi.fn()
    renderView({ onExport })

    fireEvent.click(screen.getByRole('button', { name: i18n.t('cards.exportCsv') }))

    expect(onExport).toHaveBeenCalledTimes(1)
  })

  it('Ver lançamentos foca a âncora do extrato existente (sem rota/modal nova)', () => {
    renderView()

    fireEvent.click(screen.getByRole('button', { name: i18n.t('cards.viewStatement') }))

    expect(document.activeElement?.getAttribute('data-testid')).toBe('cards-statement-anchor')
  })
})

describe('whenModuleSourcesAreScanned_thenNoMockBankingActionsLeak', () => {
  it('zero "Extrato PDF"/"Linha Digitável"/Pix/barcode/toast de compensação bancária', () => {
    const forbidden = [
      'Extrato PDF',
      'Linha Digit',
      'pixCopyPaste',
      'barcode',
      'qrCodeUrl',
      'minimumPayment',
      'MOCK_',
      'confirmação bancária',
      'compensação bancária',
    ]
    const offenders: string[] = []
    for (const file of moduleSources()) {
      const source = readFileSync(file, 'utf8')
      for (const token of forbidden) {
        if (source.toLowerCase().includes(token.toLowerCase())) offenders.push(`${file} -> ${token}`)
      }
      if (/\bpix\b/i.test(source)) offenders.push(`${file} -> pix`)
    }
    expect(offenders).toEqual([])
  })

  it('zero imports da galeria @/components/shadcn/credit-card (exceto componentes canônicos reutilizáveis)', () => {
    const offenders: string[] = []
    const ALLOWED_REUSABLE = new Set([
      '@/components/shadcn/credit-card/card-invoice-header',
      '@/components/shadcn/credit-card/card-selector-bar',
      '@/components/shadcn/credit-card/invoice-month-tabs',
      '@/components/shadcn/credit-card/card-expenses-table',
    ])
    for (const file of moduleSources()) {
      const source = readFileSync(file, 'utf8')
      const imports = [...source.matchAll(/from '(@\/components\/shadcn[^']*)'/g)].map((match) => match[1])
      for (const imp of imports) {
        if (
          (imp === '@/components/shadcn/credit-card' || imp?.startsWith('@/components/shadcn/credit-card/')) &&
          !ALLOWED_REUSABLE.has(imp)
        ) {
          offenders.push(`${file} -> ${imp}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
