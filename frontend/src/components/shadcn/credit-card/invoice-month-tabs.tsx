import { useCallback, useId, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/cn"
import type { CardInvoice, InvoiceStatus } from "./statement-types"

export interface InvoiceMonthTabsProps {
  /** Lista de códigos ISO de período (ex: ["2026-12", "2026-11", "2026-10", ...]) */
  periodCodes?: string[]
  /** Código do período atualmente selecionado */
  active?: string | null
  /** Mapa de valores totais por período em centavos (ex: { "2026-12": 125000 }) */
  totals?: Record<string, number>
  /** Mapa opcional de status por período */
  statuses?: Record<string, InvoiceStatus | string>
  /** Callback acionado ao selecionar um código de período */
  onSelect?: (periodCode: string) => void

  // --- Modo de compatibilidade com faturas diretas do template ---
  /** Lista de faturas estruturadas */
  invoices?: CardInvoice[]
  /** ID da fatura selecionada */
  selectedInvoiceId?: string
  /** Callback ao selecionar uma fatura */
  onSelectInvoice?: (invoiceId: string) => void

  /** Classes CSS adicionais do container */
  className?: string
}

function periodLabel(periodCode: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(periodCode)
  if (!match) return periodCode
  const formatted = new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit" }).format(
    new Date(Number(match[1]), Number(match[2]) - 1, 1)
  )
  return formatted.replace(".", "")
}

function getStatusDotColor(status?: string, isSelected?: boolean) {
  switch (status) {
    case "paid":
      return isSelected ? "bg-emerald-300 dark:bg-emerald-400" : "bg-emerald-500"
    case "closed":
      return isSelected ? "bg-amber-300 dark:bg-amber-400" : "bg-amber-500"
    case "open":
    case "partial":
      return isSelected ? "bg-cyan-200 dark:bg-cyan-300" : "bg-cyan-500"
    case "future":
      return isSelected ? "bg-primary-foreground/60" : "bg-muted-foreground/50"
    default:
      return null
  }
}

export function InvoiceMonthTabs({
  periodCodes: propsPeriodCodes,
  active: propsActive,
  totals: _propsTotals,
  statuses = {},
  onSelect,
  invoices,
  selectedInvoiceId,
  onSelectInvoice,
  className,
}: InvoiceMonthTabsProps) {
  const { t, i18n } = useTranslation()
  const tablistId = useId()

  // Unificação e ordenação decrescente (mais recente primeiro / fatura aberta no início)
  const derivedPeriodCodes: string[] = useMemo(() => {
    if (invoices && invoices.length > 0) {
      // Prioriza a fatura aberta no início, seguida das demais por período decrescente
      const sortedInvoices = [...invoices].sort((a, b) => {
        const aOpen = (a.status as string) === "open" || (a.status as string) === "partial" ? 1 : 0
        const bOpen = (b.status as string) === "open" || (b.status as string) === "partial" ? 1 : 0
        if (aOpen !== bOpen) return bOpen - aOpen
        return (b.periodCode || b.id).localeCompare(a.periodCode || a.id)
      })
      return sortedInvoices.map((inv) => inv.periodCode || inv.id)
    }
    return propsPeriodCodes || []
  }, [invoices, propsPeriodCodes])

  const derivedStatuses: Record<string, string> = useMemo(() => {
    const map: Record<string, string> = { ...statuses }
    if (invoices) {
      for (const inv of invoices) {
        const code = inv.periodCode || inv.id
        if (inv.status && !map[code]) {
          map[code] = inv.status
        }
      }
    }
    return map
  }, [invoices, statuses])

  // Fallback inteligente: a primeira aba (mais recente / em aberto) é o padrão
  const effectiveActive = useMemo(() => {
    if (propsActive) return propsActive
    if (invoices && selectedInvoiceId) {
      const match = invoices.find((inv) => inv.id === selectedInvoiceId)
      if (match) return match.periodCode || match.id
    }
    return derivedPeriodCodes[0] || null
  }, [propsActive, invoices, selectedInvoiceId, derivedPeriodCodes])

  const activeIndex = derivedPeriodCodes.findIndex((code) => code === effectiveActive)
  const effectiveActiveIndex = activeIndex >= 0 ? activeIndex : 0
  const periodKey = derivedPeriodCodes.join("|")

  const tabRefs = useRef(new Map<number, HTMLButtonElement>())
  const focusIntent = useRef<number | null>(null)

  const registerTab = useCallback((index: number, node: HTMLButtonElement | null) => {
    if (node) tabRefs.current.set(index, node)
    else tabRefs.current.delete(index)
  }, [])

  const selectIndex = useCallback(
    (index: number) => {
      const code = derivedPeriodCodes[index]
      if (!code) return
      focusIntent.current = index
      onSelect?.(code)

      if (invoices && onSelectInvoice) {
        const matched = invoices.find((inv) => (inv.periodCode || inv.id) === code)
        if (matched) {
          onSelectInvoice(matched.id)
        }
      }
    },
    [derivedPeriodCodes, invoices, onSelect, onSelectInvoice]
  )

  useLayoutEffect(() => {
    const intent = focusIntent.current
    if (intent !== null) {
      const intendedTab = tabRefs.current.get(intent)
      if (intendedTab) {
        intendedTab.focus({ preventScroll: true })
        focusIntent.current = null
      }
    }

    const activeTab = tabRefs.current.get(effectiveActiveIndex)
    if (!activeTab || typeof activeTab.scrollIntoView !== "function") return
    const reduced =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false
    activeTab.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      inline: "nearest",
      block: "nearest",
    })
  }, [effectiveActiveIndex, periodKey])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let nextIndex: number
    switch (event.key) {
      case "ArrowLeft":
        nextIndex = effectiveActiveIndex - 1
        break
      case "ArrowRight":
        nextIndex = effectiveActiveIndex + 1
        break
      case "Home":
        nextIndex = 0
        break
      case "End":
        nextIndex = derivedPeriodCodes.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    if (
      nextIndex < 0 ||
      nextIndex >= derivedPeriodCodes.length ||
      nextIndex === effectiveActiveIndex
    )
      return
    selectIndex(nextIndex)
  }

  if (derivedPeriodCodes.length === 0) return null

  return (
    <div
      id={tablistId}
      role="tablist"
      aria-label={t("cards.period.ariaLabel")}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex min-w-0 items-center gap-1.5 overflow-x-auto scrollbar-none py-1 snap-x snap-mandatory touch-pan-x",
        className
      )}
      style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
    >
      {derivedPeriodCodes.map((code, index) => {
        const selected = index === effectiveActiveIndex
        const status = derivedStatuses[code]
        const dotColor = getStatusDotColor(status, selected)

        return (
          <button
            key={code}
            ref={(node) => registerTab(index, node)}
            type="button"
            role="tab"
            data-period-code={code}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => selectIndex(index)}
            className={cn(
              "px-3.5 py-1.5 rounded-lg text-xs font-semibold shrink-0 cursor-pointer flex items-center gap-2 transition-all select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring snap-start",
              selected
                ? "bg-primary text-primary-foreground shadow-xs font-bold"
                : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground border border-transparent"
            )}
          >
            <span>{periodLabel(code, i18n.language)}</span>
            {dotColor && (
              <span
                className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotColor)}
                aria-hidden="true"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
