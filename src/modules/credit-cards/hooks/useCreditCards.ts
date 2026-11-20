import { useMemo, useState } from 'react'
import { useCreditCardsStore } from '../store/credit-cards.store'
import type { InvoiceRow } from '../service/credit-cards.service'
import {
  consolidatedVerdict,
  displayInvoiceStatus,
  remainingCents,
  todayLocalISO,
  type CardsVerdict,
} from '../model/credit-card'

// C1.3 — hook-first: seleção cartão/mês, filtros de despesas, contadores e
// veredito consolidado. Agregados em cents, sem N+1 (faturas já no store).

export type ExpenseFilter = 'all' | 'pending' | 'installments'

export interface InvoiceCounters {
  openCount: number
  closedCount: number
  partialCount: number
  paidCount: number
}

function periodCodeOf(periodStart: string): string {
  return periodStart.slice(0, 7)
}

function latestFirst(a: InvoiceRow, b: InvoiceRow): number {
  return b.period_start.localeCompare(a.period_start)
}

export function useCreditCards() {
  const cards = useCreditCardsStore((s) => s.cards)
  const invoicesByCard = useCreditCardsStore((s) => s.invoicesByCard)
  const selectedCardId = useCreditCardsStore((s) => s.selectedCardId)
  const setSelectedCardId = useCreditCardsStore((s) => s.selectCard)
  const status = useCreditCardsStore((s) => s.status)
  const invoicesStatus = useCreditCardsStore((s) => s.invoicesStatus)
  const error = useCreditCardsStore((s) => s.error)

  const [periodCode, setPeriodCode] = useState<string | null>(null)
  const [expenseFilter, setExpenseFilter] = useState<ExpenseFilter>('all')

  // '' é seleção válida: modo consolidado agrega faturas de todos os cartões.
  // Sem fallback para cards[0] — o veredito agregado (total em aberto) é o
  // estado padrão e explícito do seletor.
  const isConsolidated = selectedCardId === ''
  const activeCardId = selectedCardId

  const invoices = useMemo(() => {
    const list = isConsolidated
      ? Object.values(invoicesByCard).flat()
      : (activeCardId ? (invoicesByCard[activeCardId] ?? []) : [])
    return [...list].sort(latestFirst)
  }, [invoicesByCard, activeCardId, isConsolidated])

  // Ciclos únicos (consolidado tem N faturas por período, uma por cartão).
  // Fatura aberta (display open/partial) lidera; demais seguem latestFirst.
  const periodCodes = useMemo(() => {
    const seen = new Set<string>()
    const codes: string[] = []
    const openPeriods = new Set<string>()
    const todayISO = todayLocalISO()
    for (const invoice of invoices) {
      const code = periodCodeOf(invoice.period_start)
      if (!seen.has(code)) {
        seen.add(code)
        codes.push(code)
      }
      const status = displayInvoiceStatus(invoice, todayISO)
      if (status === 'open' || status === 'partial') {
        openPeriods.add(code)
      }
    }
    const firstOpen = codes.find((code) => openPeriods.has(code))
    if (!firstOpen) return codes
    return [firstOpen, ...codes.filter((code) => code !== firstOpen)]
  }, [invoices])

  const effectivePeriod = periodCode ?? periodCodes[0] ?? null

  const selectedInvoice = useMemo(() => {
    if (!effectivePeriod) return null
    return invoices.find((i) => periodCodeOf(i.period_start) === effectivePeriod) ?? null
  }, [invoices, effectivePeriod])

  const counters = useMemo<InvoiceCounters>(() => {
    const result: InvoiceCounters = { openCount: 0, closedCount: 0, partialCount: 0, paidCount: 0 }
    for (const invoice of invoices) {
      if (invoice.status === 'open') result.openCount += 1
      else if (invoice.status === 'closed') result.closedCount += 1
      else if (invoice.status === 'partial') result.partialCount += 1
      else if (invoice.status === 'paid') result.paidCount += 1
    }
    return result
  }, [invoices])

  // Veredito sempre global (todos os cartões e faturas): alimenta o chip
  // consolidado e o total em aberto independente da seleção. Escopo por
  // cartão vive em `invoices`/`counters`/`periodInvoiceIds`.
  const verdict = useMemo<CardsVerdict>(() => {
    const allInvoices = Object.values(invoicesByCard).flat()
    return consolidatedVerdict(cards, allInvoices)
  }, [cards, invoicesByCard])

  const selectedRemainingCents = selectedInvoice ? remainingCents(selectedInvoice) : 0

  // Faturas do ciclo efetivo: consolidado agrega todos os cartões do período;
  // com cartão selecionado, só a fatura dele. Base do filtro de despesas.
  const periodInvoiceIds = useMemo(() => {
    if (!effectivePeriod) return [] as string[]
    return invoices
      .filter((invoice) => periodCodeOf(invoice.period_start) === effectivePeriod)
      .map((invoice) => invoice.id)
  }, [invoices, effectivePeriod])

  return {
    cards,
    selectedCardId: activeCardId,
    isConsolidated,
    setSelectedCardId,
    selectedCard: cards.find((c) => c.id === activeCardId) ?? null,
    invoices,
    periodCodes,
    periodCode: effectivePeriod,
    setPeriodCode,
    selectedInvoice,
    periodInvoiceIds,
    selectedRemainingCents,
    expenseFilter,
    setExpenseFilter,
    counters,
    verdict,
    status,
    invoicesStatus,
    error,
  }
}
