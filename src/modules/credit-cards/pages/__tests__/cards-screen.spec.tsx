// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'

import { CardsScreen, resolveExpenseCardLast4, resolvePayTarget } from '../CardsScreen'
import type { CreditCardRow, InvoiceRow } from '../../service/credit-cards.service'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

const payInvoiceMock = vi.hoisted(() => vi.fn())
const createCardPurchaseMock = vi.hoisted(() => vi.fn())
const createInstallmentPurchaseMock = vi.hoisted(() => vi.fn())
vi.mock('../../service/credit-cards.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../service/credit-cards.service')>()
  return {
    ...actual,
    payInvoice: payInvoiceMock,
    createCardPurchase: createCardPurchaseMock,
    createInstallmentPurchase: createInstallmentPurchaseMock,
  }
})

const loadCategories = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/modules/categories/store/categories.store', () => ({
  useCategoriesStore: (sel: (s: unknown) => unknown) =>
    sel({
      categories: [
        { id: 'cat-mercado', name: 'Mercado', type: 'expense' },
        { id: 'cat-salario', name: 'Salário', type: 'income' },
      ],
      status: 'ready',
      load: loadCategories,
    }),
}))

const loadCards = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const loadInvoices = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const loadAccounts = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const loadTransactions = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

const CARD: CreditCardRow = {
  id: 'c-1',
  user_id: 'u-1',
  account_id: 'acc-1',
  tenant_id: null,
  name: 'Nubank Final 1234',
  limit_cents: 500000,
  closing_day: 10,
  due_day: 20,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  last4: null,
  holder_name: null,
  expiry_mm_aa: null,
  theme: 'platinum',
  is_default: false,
}

const INVOICE: InvoiceRow = {
  id: 'inv-1',
  user_id: 'u-1',
  credit_card_id: 'c-1',
  period_start: '2026-09-11',
  period_end: '2026-10-10',
  due_date: '2026-10-20',
  status: 'closed',
  total_cents: 120000,
  paid_cents: 0,
  paid_at: null,
  created_at: '2026-09-11T00:00:00Z',
}

const cardState = vi.hoisted(() => ({
  current: {
    cards: [] as CreditCardRow[],
    invoicesByCard: {} as Record<string, InvoiceRow[]>,
    selectedCardId: 'c-1',
    status: 'ready' as const,
    invoicesStatus: 'ready' as const,
    error: null as string | null,
  },
}))

vi.mock('../../store/credit-cards.store', () => ({
  useCreditCardsStore: Object.assign(
    (sel: (s: unknown) => unknown) =>
      sel({
        ...cardState.current,
        load: loadCards,
        loadInvoices,
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        selectCard: vi.fn(),
      }),
    { getState: () => ({ ...cardState.current, load: loadCards, loadInvoices }) },
  ),
}))

vi.mock('@/modules/accounts/store/accounts.store', () => ({
  useAccountsStore: (sel: (s: unknown) => unknown) =>
    sel({
      accounts: [{ id: 'acc-1', name: 'Conta Corrente', current_balance_cents: 900000 }],
      load: loadAccounts,
    }),
}))

const txState = vi.hoisted(() => ({ current: [] as Record<string, unknown>[] }))
vi.mock('@/modules/transactions/store/transactions.store', () => ({
  useTransactionsStore: (sel: (s: unknown) => unknown) =>
    sel({ transactions: txState.current, load: loadTransactions }),
}))

const capturedBlobs = vi.hoisted(() => ({ list: [] as { parts: unknown[]; options?: BlobPropertyBag }[] }))

beforeEach(() => {
  cardState.current = {
    cards: [CARD],
    invoicesByCard: { 'c-1': [INVOICE] },
    selectedCardId: 'c-1',
    status: 'ready',
    invoicesStatus: 'ready',
    error: null,
  }
  loadCards.mockClear()
  loadInvoices.mockClear()
  loadAccounts.mockClear()
  loadTransactions.mockClear()
  loadCategories.mockClear()
  txState.current = []
  payInvoiceMock.mockReset()
  createCardPurchaseMock.mockReset()
  createCardPurchaseMock.mockResolvedValue({ id: 'tx-1' })
  createInstallmentPurchaseMock.mockReset()
  createInstallmentPurchaseMock.mockResolvedValue({ planId: 'plan-1', rows: [] })
  capturedBlobs.list = []
  const RealBlob = globalThis.Blob
  class CaptureBlob extends RealBlob {
    constructor(parts: unknown[], options?: BlobPropertyBag) {
      super(parts as BlobPart[], options)
      capturedBlobs.list.push({ parts, options })
    }
  }
  vi.stubGlobal('Blob', CaptureBlob)
  URL.createObjectURL = vi.fn(() => 'blob:fake-url')
  URL.revokeObjectURL = vi.fn()
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await i18n.changeLanguage('pt-BR')
})

function renderScreen() {
  return render(
    <I18nextProvider i18n={i18n}>
      <CardsScreen />
    </I18nextProvider>,
  )
}

describe('whenExportingInvoice_thenBlobStartsWithRealBom', () => {
  it('prefixa \\uFEFF real com MIME text/csv (Excel abre acentos)', async () => {
    const user = userEvent.setup()
    renderScreen()

    await user.click(screen.getByRole('button', { name: i18n.t('cards.table.export') }))

    expect(capturedBlobs.list).toHaveLength(1)
    const [blob] = capturedBlobs.list
    expect(blob.options?.type).toBe('text/csv;charset=utf-8')
    const first = blob.parts[0]
    const text = typeof first === 'string' ? first : String(first)
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text.startsWith('ufeff')).toBe(false)
  })
})

describe('whenSelectedCardCached_thenNoRefetchOnSelectEffect', () => {
  it('mount carrega tudo em 1 batch e efeito de seleção pula cache', async () => {
    renderScreen()

    await waitFor(() => expect(loadCards).toHaveBeenCalledTimes(1))
    // Mount: batch inicial cobre c-1 (único cartão); efeito de seleção
    // encontra invoicesByCard['c-1'] em cache e não refaz fetch.
    await waitFor(() => expect(loadInvoices).toHaveBeenCalledTimes(1))
    expect(loadInvoices).toHaveBeenCalledWith('c-1', { silent: true })
  })
})

function tx(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: 'u-1',
    account_id: 'acc-1',
    invoice_id: 'inv-1',
    category_id: null,
    description: `Compra ${id}`,
    amount_cents: 1500,
    date: '2026-09-15',
    type: 'expense',
    is_transfer: false,
    reconciled: false,
    installment_number: null,
    installment_plan_id: null,
    ...overrides,
  }
}

describe('whenTransactionHasCategory_thenExpenseShowsCategoryName', () => {
  it('resolve category_id contra o store e exibe badge; id órfão/nulo cai em Sem categoria', async () => {
    txState.current = [
      tx('cat', { description: 'Compra com categoria', category_id: 'cat-mercado' }),
      tx('orphan', { description: 'Compra órfã', category_id: 'cat-removida' }),
      tx('none', { description: 'Compra sem categoria', category_id: null }),
    ]
    renderScreen()

    expect(await screen.findByText('Mercado')).toBeTruthy()
    expect(screen.getAllByText(i18n.t('cards.purchase.noCategory'))).toHaveLength(2)
  })
})

describe('whenScreenMounts_thenLoadsCategoriesForPurchaseDialog', () => {
  it('carrega categorias no mount (silent) e o Select do modal mostra só despesas', async () => {
    const user = userEvent.setup()
    renderScreen()

    expect(loadCategories).toHaveBeenCalledTimes(1)
    expect(loadCategories).toHaveBeenCalledWith({ silent: true })

    await user.click(screen.getByRole('button', { name: i18n.t('cards.transactions.newPurchase') }))
    await user.click(screen.getByRole('combobox', { name: i18n.t('cards.purchase.category') }))

    expect(await screen.findByRole('option', { name: 'Mercado' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Salário' })).toBeNull()
    expect(
      screen.getByRole('option', { name: i18n.t('cards.purchase.categoryPlaceholder') }),
    ).toBeTruthy()
  })
})

describe('whenPurchaseIsSubmitted_thenServiceRunsAndDataRefreshes', () => {
  async function openFillAndSubmit(installments: string) {
    const user = userEvent.setup()
    renderScreen()
    await waitFor(() => expect(loadCards).toHaveBeenCalledTimes(1))
    loadInvoices.mockClear()
    loadTransactions.mockClear()

    await user.click(screen.getByRole('button', { name: i18n.t('cards.transactions.newPurchase') }))
    fireEvent.change(screen.getByLabelText(i18n.t('cards.installmentDescription')), {
      target: { value: 'Mercado' },
    })
    fireEvent.change(screen.getByLabelText(i18n.t('cards.installmentTotal')), {
      target: { value: '15000' },
    })
    fireEvent.change(screen.getByLabelText(i18n.t('cards.purchaseDate')), {
      target: { value: '2026-04-14' },
    })
    fireEvent.change(screen.getByLabelText(i18n.t('cards.installmentCount')), {
      target: { value: installments },
    })
    fireEvent.submit(
      screen.getByRole('button', { name: i18n.t('cards.installmentSubmit') }).closest('form') as HTMLFormElement,
    )
  }

  it('1x: service 1x com adapter Card→Row e refresh de transações + faturas', async () => {
    await openFillAndSubmit('1')

    await waitFor(() => expect(createCardPurchaseMock).toHaveBeenCalledTimes(1))
    expect(createCardPurchaseMock.mock.calls[0][0]).toMatchObject({
      id: 'c-1',
      account_id: 'acc-1',
      closing_day: 10,
      due_day: 20,
    })
    expect(createCardPurchaseMock.mock.calls[0][1]).toEqual({
      description: 'Mercado',
      totalCents: 15000,
      date: '2026-04-14',
      categoryId: null,
    })
    expect(createInstallmentPurchaseMock).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(loadTransactions).toHaveBeenCalledWith({ pageSize: 1000, silent: true }),
    )
    expect(loadInvoices).toHaveBeenCalledWith('c-1', { silent: true })
    expect(toastMocks.success).toHaveBeenCalled()
  })

  it('3x: service Nx com count/firstDate e o mesmo refresh', async () => {
    await openFillAndSubmit('3')

    await waitFor(() => expect(createInstallmentPurchaseMock).toHaveBeenCalledTimes(1))
    expect(createInstallmentPurchaseMock.mock.calls[0][0]).toMatchObject({ id: 'c-1' })
    expect(createInstallmentPurchaseMock.mock.calls[0][1]).toEqual({
      description: 'Mercado',
      totalCents: 15000,
      count: 3,
      firstDate: '2026-04-14',
      categoryId: null,
    })
    expect(createCardPurchaseMock).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(loadTransactions).toHaveBeenCalledWith({ pageSize: 1000, silent: true }),
    )
    expect(loadInvoices).toHaveBeenCalledWith('c-1', { silent: true })
  })
})

describe('whenResolvingPayTarget_thenConsolidatedModeThrowsFirst', () => {
  it("modo consolidado ('') recusa antes de olhar a fatura", () => {
    expect(() => resolvePayTarget('', INVOICE)).toThrow('select-card-first')
  })

  it('sem fatura recusa com invoice-not-found', () => {
    expect(() => resolvePayTarget('c-1', null)).toThrow('invoice-not-found')
  })

  it('cartão + fatura válidos resolvem o alvo', () => {
    expect(resolvePayTarget('c-1', INVOICE)).toBe(INVOICE)
  })
})

describe('whenResolvingExpenseLast4_thenStoredMapsAreUsedWithoutNewFetch', () => {
  it('invoice_id -> credit_card_id -> last4 pelas props já carregadas no store', () => {
    const cardIdByInvoiceId = new Map([
      ['inv-1', 'c-1'],
      ['inv-2', 'c-2'],
    ])
    const last4ByCardId = new Map<string, string | null>([
      ['c-1', '4242'],
      ['c-2', null],
    ])

    expect(resolveExpenseCardLast4('inv-1', cardIdByInvoiceId, last4ByCardId)).toBe('4242')
    expect(resolveExpenseCardLast4('inv-2', cardIdByInvoiceId, last4ByCardId)).toBeNull()
    expect(resolveExpenseCardLast4('inv-desconhecida', cardIdByInvoiceId, last4ByCardId)).toBeNull()
  })

  it('detalhe do lançamento mostra o last4 real do cartão da fatura', async () => {
    cardState.current.cards = [{ ...CARD, last4: '4242' }]
    txState.current = [tx('last4')]

    renderScreen()

    fireEvent.click(await screen.findByText('Compra last4'))
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText('•••• 4242')).toBeTruthy()
    expect(within(dialog).getByText('Transação processada no cartão terminado em •••• 4242')).toBeTruthy()
    expect(loadInvoices).toHaveBeenCalledTimes(1)
  })

  it('cartão sem last4 persistido mostra fallback neutro', async () => {
    cardState.current.cards = [{ ...CARD, last4: null }]
    txState.current = [tx('sem-last4')]

    renderScreen()

    fireEvent.click(await screen.findByText('Compra sem-last4'))
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText('Transação processada em cartão')).toBeTruthy()
    expect(within(dialog).queryByText(/terminado em/)).toBeNull()
  })
})
