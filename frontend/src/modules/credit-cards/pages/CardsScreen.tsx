import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/ui/alert'
import { Button } from '@/components/shadcn/ui/button'
import { Skeleton } from '@/components/shadcn/ui/skeleton'
import { CardsView } from '../components/CardsView'
import type { ExpenseRow } from '@/components/shadcn/credit-card/card-expenses-table'
import type { CreditCardInput, CreditCardUpdateInput } from '../model/credit-card'
import { creditCardRowToView } from '../model/credit-card'
import type { CardPurchaseSubmitInput } from '../components/CardPurchaseDialog'
import { buildInvoiceCsv, createInvoiceCsvBlob } from '@/lib/csv'
import {
  createCardPurchase,
  createInstallmentPurchase,
  creditCardViewToPurchaseCard,
  payInvoice,
  type InvoiceRow,
} from '../service/credit-cards.service'
import { useCreditCardsStore } from '../store/credit-cards.store'
import { useCreditCards } from '../hooks/useCreditCards'
import { useCategoriesStore } from '@/modules/categories/store/categories.store'
import { useAccountsStore } from '@/modules/accounts/store/accounts.store'
import { useTransactionsStore } from '@/modules/transactions/store/transactions.store'

// /cartoes alimentada pelo Supabase via stores + adapters.
// Dinheiro em BIGINT cents; pagamento via RPC (valor calculado no servidor).

// Alvo de pagamento: modo consolidado ('') nunca paga — exige seleção de
// cartão antes de abrir o diálogo (evita quitar a fatura errada do ciclo).
export function resolvePayTarget(selectedCardId: string, invoice: InvoiceRow | null): InvoiceRow {
  if (selectedCardId === '') throw new Error('select-card-first')
  if (!invoice) throw new Error('invoice-not-found')
  return invoice
}

// Resolução pura do último dígito do cartão a partir dos mapas já carregados
// no store: nenhuma consulta por linha, nenhum número inventado no detalhe.
export function resolveExpenseCardLast4(
  invoiceId: string,
  cardIdByInvoiceId: ReadonlyMap<string, string>,
  last4ByCardId: ReadonlyMap<string, string | null>,
): string | null {
  const cardId = cardIdByInvoiceId.get(invoiceId)
  return cardId === undefined ? null : (last4ByCardId.get(cardId) ?? null)
}

export function CardsScreen() {
  const { t } = useTranslation()

  const loadCards = useCreditCardsStore((state) => state.load)
  const loadInvoices = useCreditCardsStore((state) => state.loadInvoices)
  const createCard = useCreditCardsStore((state) => state.create)
  const updateCard = useCreditCardsStore((state) => state.update)
  const removeCard = useCreditCardsStore((state) => state.remove)

  const loadAccounts = useAccountsStore((state) => state.load)
  const accountRows = useAccountsStore((state) => state.accounts)
  const categoryRows = useCategoriesStore((state) => state.categories)
  const loadCategories = useCategoriesStore((state) => state.load)
  const invoicesByCard = useCreditCardsStore((state) => state.invoicesByCard)

  const loadTransactions = useTransactionsStore((state) => state.load)
  const transactionRows = useTransactionsStore((state) => state.transactions)

  const [search, setSearch] = useState('')
  const [archivedIds, setArchivedIds] = useState<string[]>([])
  const [principalCardId, setPrincipalCardId] = useState<string | null>(null)

  const {
    cards,
    selectedCardId,
    isConsolidated,
    setSelectedCardId,
    invoices,
    periodCodes,
    periodCode,
    setPeriodCode,
    selectedInvoice,
    periodInvoiceIds,
    expenseFilter,
    setExpenseFilter,
    verdict,
    status,
    error,
  } = useCreditCards()

  // Mount carrega tudo em 1 batch: cartões + contas + transações + categorias
  // (esta última alimenta o Select do modal de compra). Sem N+1 por linha:
  // o seletor e o veredito leem do store, nunca disparam fetch por cartão/linha.
  useEffect(() => {
    void Promise.all([
      loadCards(),
      loadAccounts(),
      loadTransactions({ pageSize: 1000, silent: true }),
      loadCategories({ silent: true }),
    ]).then(
      () => {
        const ids = useCreditCardsStore.getState().cards.map((card) => card.id)
        if (ids.length === 0) return
        void Promise.all(ids.map((id) => loadInvoices(id, { silent: true })))
      },
    )
  }, [loadCards, loadAccounts, loadTransactions, loadCategories, loadInvoices])

  // Troca de cartão busca a fatura só em cache-miss: o mount já cobre o
  // batch inicial, este efeito cobre navegação posterior sem refetch cego.
  useEffect(() => {
    if (selectedCardId && !invoicesByCard[selectedCardId]) void loadInvoices(selectedCardId)
  }, [selectedCardId, invoicesByCard, loadInvoices])

  const cardViews = useMemo(() => cards.map((row) => creditCardRowToView(row)), [cards])

  const purchaseCategories = useMemo(
    () =>
      categoryRows
        .filter((row) => row.type === 'expense')
        .map((row) => ({ id: row.id, name: row.name })),
    [categoryRows],
  )

  // Totais por ciclo somados entre cartões: no consolidado, o mesmo período
  // existe em N faturas (uma por cartão).
  const invoiceTotals = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const invoice of invoices) {
      const code = invoice.period_start.slice(0, 7)
      totals[code] = (totals[code] ?? 0) + invoice.total_cents
    }
    return totals
  }, [invoices])

  // Despesas do ciclo efetivo: consolidado agrega lançamentos de todos os
  // cartões do período; com cartão selecionado, só a fatura dele.
  const periodInvoiceIdSet = useMemo(() => new Set(periodInvoiceIds), [periodInvoiceIds])
  const categoryNameById = useMemo(
    () => new Map(categoryRows.map((row) => [row.id, row.name])),
    [categoryRows],
  )
  const cardIdByInvoiceId = useMemo(() => {
    const map = new Map<string, string>()
    for (const invoices of Object.values(invoicesByCard)) {
      for (const invoice of invoices) map.set(invoice.id, invoice.credit_card_id)
    }
    return map
  }, [invoicesByCard])
  const last4ByCardId = useMemo(
    () => new Map(cardViews.map((cardItem) => [cardItem.id, cardItem.last4 ?? null])),
    [cardViews],
  )

  const expenses = useMemo<ExpenseRow[]>(() => {
    if (periodInvoiceIdSet.size === 0) return []
    return transactionRows
      .filter((row) => row.invoice_id !== null && periodInvoiceIdSet.has(row.invoice_id))
      .map((row) => ({
        id: row.id,
        description: row.description,
        date: row.date,
        amountCents: row.amount_cents,
        installmentLabel:
          row.installment_number === null || row.installment_number === undefined
            ? null
            : t('cards.installmentLabel', { n: row.installment_number }),
        categoryName:
          row.category_id === null ? null : (categoryNameById.get(row.category_id) ?? null),
        pending: !row.reconciled && !row.is_transfer,
        isTransfer: row.is_transfer,
        cardLast4: row.invoice_id
          ? resolveExpenseCardLast4(row.invoice_id, cardIdByInvoiceId, last4ByCardId)
          : null,
      }))
  }, [transactionRows, periodInvoiceIdSet, categoryNameById, cardIdByInvoiceId, last4ByCardId, t])

  const payAccounts = useMemo(
    () =>
      accountRows.map((row) => ({
        id: row.id,
        name: row.name,
        balanceCents: row.current_balance_cents ?? null,
      })),
    [accountRows],
  )

  async function handleCreate(input: CreditCardInput): Promise<void> {
    await createCard(input)
    toast.success(t('cards.saved'))
  }

  async function handleUpdate(id: string, patch: CreditCardUpdateInput): Promise<void> {
    await updateCard(id, patch)
    toast.success(t('cards.saved'))
  }

  async function handleDelete(id: string): Promise<void> {
    await removeCard(id)
    toast.success(t('cards.removed'))
  }

  async function handlePay(accountId: string, date: string): Promise<void> {
    const target = resolvePayTarget(selectedCardId, selectedInvoice)
    if (isConsolidated) throw new Error('select-card-first')
    await payInvoice({ invoiceId: target.id, accountId, date })
    toast.success(t('cards.transfer.success'))
    await Promise.all([
      loadInvoices(target.credit_card_id, { silent: true }),
      loadTransactions({ pageSize: 1000, silent: true }),
    ])
  }

  async function handlePurchase(input: CardPurchaseSubmitInput): Promise<void> {
    if (selectedCardId === '') throw new Error('select-card-first')
    const cardView = cardViews.find((view) => view.id === selectedCardId)
    if (!cardView) throw new Error('card-not-found')
    const card = creditCardViewToPurchaseCard(cardView)

    if (input.installments === 1) {
      await createCardPurchase(card, {
        description: input.description,
        totalCents: input.totalCents,
        date: input.date,
        categoryId: input.categoryId,
      })
    } else {
      await createInstallmentPurchase(card, {
        description: input.description,
        totalCents: input.totalCents,
        count: input.installments,
        firstDate: input.date,
        categoryId: input.categoryId,
      })
    }

    toast.success(t('cards.installmentSuccess', { count: input.installments }))
    await Promise.all([
      loadInvoices(selectedCardId, { silent: true }),
      loadTransactions({ pageSize: 1000, silent: true }),
    ])
  }

  function handleExport() {
    const csv = buildInvoiceCsv(expenses)
    const blob = createInvoiceCsvBlob(csv)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `fatura-${periodCode ?? 'atual'}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex w-full flex-col gap-5 px-4 pb-8 lg:px-6" aria-busy="true" aria-live="polite">
        <Skeleton className="h-36 w-full rounded-2xl" />
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-2xl" />
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex w-full flex-col gap-5 px-4 pb-8 lg:px-6">
        <Alert variant="destructive">
          <AlertTitle>{t('common.error')}</AlertTitle>
          <AlertDescription>{error ?? t('cards.loadError')}</AlertDescription>
        </Alert>
        <Button onClick={() => void loadCards()} variant="outline" className="min-h-11 w-fit">
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  return (
    <CardsView
      cards={cardViews}
      selectedCardId={selectedCardId}
      invoices={invoices}
      invoicesByCard={invoicesByCard}
      periodCode={periodCode}
      periodCodes={periodCodes}
      invoiceTotals={invoiceTotals}
      expenses={expenses}
      expenseFilter={expenseFilter}
      search={search}
      accounts={payAccounts}
      categories={purchaseCategories}
      totalOpenCents={verdict.totalOutstandingCents}
      totalLimitCents={verdict.totalLimitCents}
      archivedIds={archivedIds}
      principalCardId={principalCardId}
      onSelectCard={(id) => {
        setSelectedCardId(id)
      }}
      onPeriodChange={setPeriodCode}
      onFilterChange={setExpenseFilter}
      onSearchChange={setSearch}
      onExport={handleExport}
      onCreateCard={handleCreate}
      onUpdateCard={handleUpdate}
      onDeleteCard={handleDelete}
      onArchiveCard={(id) => setArchivedIds((previous) => [...previous, id])}
      onSetPrincipal={setPrincipalCardId}
      onPayInvoice={handlePay}
      onPurchase={handlePurchase}
    />
  )
}
