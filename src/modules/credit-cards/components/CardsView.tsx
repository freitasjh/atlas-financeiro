import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, CalendarDays, CreditCard, Receipt } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/shadcn/ui/button'
import { ViewModeToggle } from '@/components/shadcn/ui/view-mode-toggle'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/shadcn/ui/empty'
import type { CreditCardInput, CreditCardUpdateInput, CreditCardView } from '../model/credit-card'
import type { InvoiceRow } from '../service/credit-cards.service'
import {
  displayDueDate,
  displayInvoiceStatus,
  remainingCents,
  type DisplayDueDate,
} from '../model/credit-card'
import { formatCentsBRL } from '@/lib/utils'
import { useCardsView, type CardsViewMode } from '../hooks/useCardsView'
import type { ExpenseFilter } from '../hooks/useCreditCards'
import {
  CardSelectorBar,
  type CardSelectorCard,
} from '@/components/shadcn/credit-card/card-selector-bar'
import { CardInvoiceHeader } from '@/components/shadcn/credit-card/card-invoice-header'
import { InvoiceMonthTabs } from '@/components/shadcn/credit-card/invoice-month-tabs'
import { CardExpensesTable, type ExpenseRow } from '@/components/shadcn/credit-card/card-expenses-table'
import { CardsWalletGrid } from './CardsWalletGrid'
import { AddCardDialog } from './AddCardDialog'
import { EditCardDialog } from './EditCardDialog'
import { DeleteCardDialog } from './DeleteCardDialog'
import { PayInvoiceDialog, type PayAccountOption } from './PayInvoiceDialog'
import { ExpenseDetailDialog } from './ExpenseDetailDialog'
import {
  CardPurchaseDialog,
  type CardPurchaseSubmitInput,
  type PurchaseCategoryOption,
} from './CardPurchaseDialog'

export interface CardsViewProps {
  cards: CreditCardView[]
  selectedCardId: string
  invoices: InvoiceRow[]
  invoicesByCard: Record<string, InvoiceRow[]>
  periodCode: string | null
  periodCodes: string[]
  invoiceTotals: Record<string, number>
  expenses: ExpenseRow[]
  expenseFilter: ExpenseFilter
  search: string
  accounts: PayAccountOption[]
  categories?: PurchaseCategoryOption[]
  totalOpenCents: number
  totalLimitCents?: number
  archivedIds: string[]
  principalCardId: string | null
  initialViewMode?: CardsViewMode
  onSelectCard: (id: string) => void
  onPeriodChange: (periodCode: string) => void
  onFilterChange: (filter: ExpenseFilter) => void
  onSearchChange: (value: string) => void
  onExport: () => void
  onCreateCard: (input: CreditCardInput) => Promise<void>
  onUpdateCard: (id: string, patch: CreditCardUpdateInput) => Promise<void>
  onDeleteCard: (id: string) => Promise<void>
  onArchiveCard: (id: string) => void
  onSetPrincipal: (id: string) => void
  onPayInvoice: (accountId: string, date: string) => Promise<void>
  onPurchase?: (input: CardPurchaseSubmitInput) => Promise<void>
}

export interface ConsolidatedVerdictView {
  closingDate: string | null
  dueDate: DisplayDueDate | null
  availableCents: number
  usedPercent: number
  hasInvoices: boolean
  allPaid: boolean
}

// Agregação de leitura pura: nenhuma regra de negócio nova, apenas projeção
// determinística das props já consolidadas (A1/A2/A3 do architect).
export function deriveConsolidatedVerdict(
  invoices: InvoiceRow[],
  periodCode: string | null,
  totalOpenCents: number,
  totalLimitCents: number,
): ConsolidatedVerdictView {
  const scoped = periodCode
    ? invoices.filter((invoice) => invoice.period_start.startsWith(periodCode))
    : invoices

  const closingDate = scoped.reduce<string | null>((latest, invoice) => {
    if (!invoice.period_end) return latest
    return latest === null || invoice.period_end > latest ? invoice.period_end : latest
  }, null)

  const unpaid = scoped.filter((invoice) => invoice.status !== 'paid')
  const dueDate = unpaid.reduce<DisplayDueDate | null>((earliest, invoice) => {
    const current = displayDueDate(invoice.due_date)
    return earliest === null || current.effective < earliest.effective ? current : earliest
  }, null)

  return {
    closingDate,
    dueDate,
    availableCents: Math.max(totalLimitCents - totalOpenCents, 0),
    usedPercent:
      totalLimitCents > 0 ? Math.min(100, Math.round((totalOpenCents / totalLimitCents) * 100)) : 0,
    hasInvoices: scoped.length > 0,
    allPaid: scoped.length > 0 && totalOpenCents === 0 && scoped.some((invoice) => invoice.status === 'paid'),
  }
}

// CardsView (Arquétipo 2): seletor + veredito 3 col + MonthTabs + tabela +
// toggle Faturas/Carteira + 5 dialogs na raiz (add/edit/delete/pay/detalhe).
export function CardsView({
  cards,
  selectedCardId,
  invoices,
  invoicesByCard,
  periodCode,
  periodCodes,
  invoiceTotals,
  expenses,
  expenseFilter,
  search,
  accounts,
  categories = [],
  totalOpenCents,
  totalLimitCents = 0,
  archivedIds,
  principalCardId,
  initialViewMode = 'statements',
  onSelectCard,
  onPeriodChange,
  onFilterChange,
  onSearchChange,
  onExport,
  onCreateCard,
  onUpdateCard,
  onDeleteCard,
  onArchiveCard,
  onSetPrincipal,
  onPayInvoice,
  onPurchase,
}: CardsViewProps) {
  const { t, i18n } = useTranslation()
  const { viewMode, setViewMode } = useCardsView(initialViewMode)
  const statementRef = useRef<HTMLDivElement>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<CreditCardView | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CreditCardView | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  const [purchaseOpen, setPurchaseOpen] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  const [isPaying, setIsPaying] = useState(false)
  const [detailExpense, setDetailExpense] = useState<ExpenseRow | null>(null)

  const visibleCards = useMemo(
    () => cards.filter((cardItem) => !archivedIds.includes(cardItem.id)),
    [cards, archivedIds],
  )
  const activeCard = useMemo(
    () => visibleCards.find((cardItem) => cardItem.id === selectedCardId) ?? null,
    [visibleCards, selectedCardId],
  )
  const selectorCards = useMemo<CardSelectorCard[]>(
    () =>
      visibleCards.map((cardItem) => {
        const cardInvoices = invoicesByCard[cardItem.id] ?? []
        const invoice = periodCode
          ? (cardInvoices.find((item) => item.period_start.startsWith(periodCode)) ?? null)
          : (cardInvoices.find((item) => item.status === 'closed' || item.status === 'open') ??
            cardInvoices[0] ??
            null)
        return {
          id: cardItem.id,
          nickname: cardItem.nickname,
          last4: cardItem.last4 ?? '••••',
          theme: cardItem.theme,
          isDefault: cardItem.id === principalCardId || cardItem.isDefault === true,
          amountCents: invoice?.total_cents ?? 0,
          status: invoice ? displayInvoiceStatus(invoice) : undefined,
        }
      }),
    [visibleCards, invoicesByCard, periodCode, principalCardId],
  )
  const selectedInvoice = useMemo(() => {
    if (!periodCode) return invoices[0] ?? null
    return invoices.find((inv) => inv.period_start.startsWith(periodCode)) ?? null
  }, [invoices, periodCode])
  const selectedRemaining = selectedInvoice ? remainingCents(selectedInvoice) : 0
  const consolidated = useMemo(
    () => deriveConsolidatedVerdict(invoices, periodCode, totalOpenCents, totalLimitCents),
    [invoices, periodCode, totalOpenCents, totalLimitCents],
  )
  const verdictDate = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(
      new Date(`${iso}T12:00:00`),
    )

  async function handleConfirmDelete() {
    if (!deleteTarget) return
    setIsDeleting(true)
    setDeleteError(null)
    try {
      await onDeleteCard(deleteTarget.id)
      setDeleteTarget(null)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'error')
    } finally {
      setIsDeleting(false)
    }
  }

  function handleArchive() {
    if (!deleteTarget) return
    onArchiveCard(deleteTarget.id)
    setDeleteTarget(null)
    setDeleteError(null)
    toast.success(t('cards.archive.done'))
  }

  function handleViewStatement() {
    const anchor = statementRef.current
    if (!anchor) return
    anchor.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    anchor.focus({ preventScroll: true })
  }

  async function handleConfirmPay(accountId: string, date: string) {
    setIsPaying(true)
    setPayError(null)
    try {
      await onPayInvoice(accountId, date)
      setPayOpen(false)
    } catch (error) {
      setPayError(error instanceof Error ? error.message : 'error')
    } finally {
      setIsPaying(false)
    }
  }

  if (visibleCards.length === 0) {
    return (
      <div className="flex w-full flex-col gap-5 px-4 pb-8 lg:px-6">
        <Empty className="border border-dashed border-border/80">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CreditCard className="h-6 w-6" />
            </EmptyMedia>
            <EmptyTitle>{t('cards.empty')}</EmptyTitle>
            <EmptyDescription>{t('cards.emptyHint')}</EmptyDescription>
          </EmptyHeader>
          <Button type="button" onClick={() => setAddOpen(true)} className="mt-4 min-h-11 text-xs font-bold">
            {t('cards.new')}
          </Button>
        </Empty>
        <AddCardDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          accounts={accounts}
          onSubmit={onCreateCard}
        />
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-5 px-4 pb-8 lg:px-6">
      <div className="flex flex-col gap-4 border-b border-border/70 pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              <CreditCard className="h-6 w-6 text-primary" />
              {t('cards.title')}
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('cards.subtitle')}</p>
          </div>
          <ViewModeToggle
            data-testid="cards-view-toggle"
            value={viewMode}
            onValueChange={(value) => setViewMode(value as CardsViewMode)}
            ariaLabel={t('cards.view.toggleLabel')}
            items={[
              {
                value: 'statements',
                label: t('cards.view.statements'),
                shortLabel: t('cards.view.statementsShort'),
                ariaLabel: t('cards.view.statements'),
                icon: Receipt,
              },
              {
                value: 'wallet',
                label: t('cards.view.walletCount', { count: visibleCards.length }),
                shortLabel: t('cards.view.walletShort'),
                ariaLabel: t('cards.view.walletCount', { count: visibleCards.length }),
                icon: Building2,
              },
            ]}
          />
        </div>

        <CardSelectorBar
          cards={selectorCards}
          selectedCardId={selectedCardId}
          totalConsolidatedCents={totalOpenCents}
          onSelectCard={onSelectCard}
          onAddNewCard={() => setAddOpen(true)}
        />
      </div>

      {viewMode === 'statements' ? (
        <div className="flex flex-col gap-4">
          {selectedCardId === '' ? (
            <CardInvoiceHeader
              data-testid="cards-consolidated-verdict"
              isConsolidated
              cardNickname={t('cards.verdict.consolidatedTitle')}
              totalAmount={totalOpenCents / 100}
              formattedTotalAmount={formatCentsBRL(totalOpenCents)}
              totalLimit={totalLimitCents > 0 ? totalLimitCents / 100 : 0}
              formattedTotalLimit={totalLimitCents > 0 ? formatCentsBRL(totalLimitCents) : undefined}
              availableLimit={totalLimitCents > 0 ? consolidated.availableCents / 100 : 0}
              formattedAvailableLimit={totalLimitCents > 0 ? formatCentsBRL(consolidated.availableCents) : undefined}
              usedLimit={totalOpenCents / 100}
              usedPercent={totalLimitCents > 0 ? consolidated.usedPercent : 0}
              hasInvoices={consolidated.hasInvoices}
              unavailableLimitLabel={t('cards.limitGauge.unavailable')}
              availableLimitLabel={t('cards.limitGauge.available')}
              totalLimitLabel={t('cards.limitGauge.total')}
              closingDate={consolidated.closingDate ? verdictDate(consolidated.closingDate) : undefined}
              dueDate={consolidated.dueDate ? verdictDate(consolidated.dueDate.effective) : undefined}
              periodRangeText={t('cards.verdict.totalLabel')}
              status={
                !consolidated.hasInvoices
                  ? 'empty'
                  : consolidated.allPaid
                    ? 'paid'
                    : 'open'
              }
              statusBadgeLabel={t(
                !consolidated.hasInvoices
                  ? 'cards.status.empty'
                  : consolidated.allPaid
                    ? 'cards.status.paid'
                    : 'cards.status.open',
              )}
              allPaidLabel={consolidated.allPaid ? t('cards.verdict.allPaid') : undefined}
              payButtonLabel={t('cards.pay')}
              payHint={t('cards.verdict.selectToPay')}
              exportButtonLabel={t('cards.exportCsv')}
              viewDetailsLabel={t('cards.viewStatement')}
              progressBarAriaText={`${t('cards.cardAria.limitUsed', { percent: consolidated.usedPercent })} · ${formatCentsBRL(totalOpenCents)}`}
              progressBarAriaLabel={t('cards.limitGauge.used')}
              dueDateNode={
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5 text-[11px] text-muted-foreground sm:text-xs">
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    <CalendarDays className="h-3.5 w-3.5 shrink-0 text-primary" />
                    {t('cards.verdict.closingDate')}:{' '}
                    <strong className="font-mono font-semibold tabular-nums text-foreground">
                      {consolidated.closingDate ? verdictDate(consolidated.closingDate) : '—'}
                    </strong>
                  </span>
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    <CalendarDays className="h-3.5 w-3.5 shrink-0 text-primary" />
                    {t('cards.verdict.nextDueDate')}:{' '}
                    {consolidated.dueDate ? (
                      <strong className="font-mono font-semibold tabular-nums text-foreground">
                        {verdictDate(consolidated.dueDate.effective)}
                      </strong>
                    ) : (
                      <span
                        role="img"
                        aria-label={t('cards.invoice.noDueDate')}
                        className="font-mono font-semibold tabular-nums text-foreground"
                      >
                        —
                      </span>
                    )}
                    {consolidated.dueDate?.shifted ? (
                      <span
                        className="ml-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold text-amber-600 dark:text-amber-400"
                        title={t('cards.notice.weekendAria', {
                          nominal: consolidated.dueDate.nominal,
                          effective: consolidated.dueDate.effective,
                        })}
                      >
                        {t('cards.notice.weekendChip')}
                      </span>
                    ) : null}
                  </span>
                </div>
              }
              onExportStatement={onExport}
              onViewDetails={handleViewStatement}
            />
          ) : (
            <CardInvoiceHeader
              cardNickname={activeCard?.nickname}
              last4={activeCard?.last4 ?? undefined}
              brand={activeCard?.brand}
              theme={activeCard?.theme}
              isDefault={activeCard?.id === principalCardId}
              totalAmount={selectedInvoice ? selectedInvoice.total_cents / 100 : 0}
              totalLimit={activeCard && activeCard.limitCents > 0 ? activeCard.limitCents / 100 : undefined}
              availableLimit={
                activeCard && activeCard.limitCents > 0 && selectedInvoice
                  ? Math.max(activeCard.limitCents - selectedInvoice.total_cents, 0) / 100
                  : undefined
              }
              usedLimit={selectedInvoice ? selectedInvoice.total_cents / 100 : 0}
              dueDate={selectedInvoice ? displayDueDate(selectedInvoice.due_date).effective : undefined}
              closingDate={selectedInvoice?.period_end}
              period={selectedInvoice ? `${selectedInvoice.period_start} a ${selectedInvoice.period_end}` : undefined}
              status={selectedInvoice?.status}
              payButtonLabel={t('cards.pay')}
              exportButtonLabel={t('cards.exportCsv')}
              viewDetailsLabel={t('cards.viewStatement')}
              statusBadgeLabel={
                selectedInvoice?.status === 'paid'
                  ? t('cards.paid')
                  : selectedInvoice?.status === 'closed'
                  ? t('cards.closed')
                  : selectedInvoice?.status === 'future'
                  ? t('cards.future')
                  : selectedInvoice?.status === 'open'
                  ? t('cards.open')
                  : undefined
              }
              onPayInvoice={() => {
                setPayError(null)
                setPayOpen(true)
              }}
              onExportStatement={onExport}
              onViewDetails={handleViewStatement}
            />
          )}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/80 pb-3">
            <InvoiceMonthTabs
              periodCodes={periodCodes}
              active={periodCode ?? periodCodes[0] ?? null}
              totals={invoiceTotals}
              onSelect={onPeriodChange}
              className="border-b-0 pb-0"
            />
          </div>
          <div
            ref={statementRef}
            tabIndex={-1}
            role="region"
            aria-label={t('cards.transactions.title')}
            data-testid="cards-statement-anchor"
            className="min-w-0 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            <CardExpensesTable
              expenses={expenses}
              filter={expenseFilter}
              search={search}
              onFilterChange={onFilterChange}
              onSearchChange={onSearchChange}
              onExport={onExport}
              onOpenDetail={setDetailExpense}
              onNewPurchase={() => setPurchaseOpen(true)}
            />
          </div>
        </div>
      ) : (
        <CardsWalletGrid
          cards={visibleCards}
          selectedCardId={selectedCardId}
          invoicesByCard={invoicesByCard}
          periodCode={periodCode}
          principalCardId={principalCardId}
          onSelect={(id) => {
            onSelectCard(id)
            setViewMode('statements')
          }}
          onSetPrincipal={onSetPrincipal}
          onEdit={setEditTarget}
          onDelete={(cardItem) => {
            setDeleteError(null)
            setDeleteTarget(cardItem)
          }}
        />
      )}

      <AddCardDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        accounts={accounts}
        onSubmit={onCreateCard}
      />
      <EditCardDialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null)
        }}
        card={editTarget}
        accounts={accounts}
        onSubmit={onUpdateCard}
      />
      <DeleteCardDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            setDeleteError(null)
          }
        }}
        cardName={deleteTarget?.nickname ?? ''}
        error={deleteError}
        isDeleting={isDeleting}
        onConfirm={() => void handleConfirmDelete()}
        onArchive={handleArchive}
      />
      <PayInvoiceDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        invoice={selectedInvoice}
        remainingCents={selectedRemaining}
        accounts={accounts}
        defaultAccountId={activeCard?.accountId}
        serverError={payError}
        isPaying={isPaying}
        onConfirm={handleConfirmPay}
      />
      <ExpenseDetailDialog
        open={detailExpense !== null}
        onOpenChange={(open) => {
          if (!open) setDetailExpense(null)
        }}
        expense={detailExpense}
      />
      <CardPurchaseDialog
        open={purchaseOpen}
        onOpenChange={setPurchaseOpen}
        card={activeCard}
        categories={categories}
        onSubmit={onPurchase ?? (async () => {})}
      />
    </div>
  )
}
