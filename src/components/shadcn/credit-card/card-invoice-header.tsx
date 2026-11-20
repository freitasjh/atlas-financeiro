import * as React from "react"
import {
  CreditCard,
  QrCode,
  Calendar,
  AlertCircle,
  CheckCircle2,
  Download,
  Receipt,
  Sparkles,
  Star,
  Copy,
  List,
} from "lucide-react"
import { Button } from "@/components/shadcn/ui/button"
import { Badge } from "@/components/shadcn/ui/badge"
import { Skeleton } from "@/components/shadcn/ui/skeleton"
import { cn } from "@/lib/cn"
import { toast } from "sonner"
import type { CardInvoice, CardLimitInfo, CardWithInvoices, InvoiceStatus } from "./statement-types"
import type { CardBrand, CardTheme } from "./credit-card-types"

export type LimitBarTone = "primary" | "amber" | "destructive"

export function limitBarTone(percent: number): LimitBarTone {
  if (percent > 85) return "destructive"
  if (percent > 60) return "amber"
  return "primary"
}

export interface CardInvoiceHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Objeto completo da fatura (opcional se passadas propriedades diretas) */
  invoice?: CardInvoice | null
  /** Objeto completo do cartão (opcional se passadas propriedades diretas) */
  card?: CardWithInvoices | null
  /** Lista de cartões para contexto consolidado */
  cards?: CardWithInvoices[]

  // --- Parâmetros Primitivos Diretos (para qualquer backend ou tela consumidora) ---
  /** Valor total da fatura */
  totalAmount?: number
  /** Data de vencimento da fatura (ex: "10/11/2026") */
  dueDate?: string
  /** Data de fechamento da fatura (ex: "03/11/2026") */
  closingDate?: string
  /** Período de competência da fatura (ex: "Novembro de 2026") */
  period?: string
  /** Status da fatura ("open" | "closed" | "paid" | "future") */
  status?: InvoiceStatus | string
  /** Linha digitável ou código de barras para pagamento */
  barcode?: string
  /** Código Pix copia e cola */
  pixCopyPaste?: string

  // --- Identidade e Detalhes do Cartão ---
  /** Apelido / Nome do cartão */
  cardNickname?: string
  /** Últimos 4 dígitos do cartão (ex: "8421") */
  last4?: string | null
  /** Bandeira do cartão */
  brand?: CardBrand | string
  /** Tema visual do mini-cartão */
  theme?: CardTheme | string
  /** Indica se é o cartão principal da conta */
  isDefault?: boolean
  /** Modo consolidado (soma de faturas de todos os cartões) */
  isConsolidated?: boolean

  // --- Limites de Crédito ---
  /** Objeto estruturado de limites */
  limits?: CardLimitInfo
  /** Limite total */
  totalLimit?: number
  /** Limite disponível */
  availableLimit?: number
  /** Limite utilizado */
  usedLimit?: number
  /** Ocultar a barra de limite (útil para cartões de débito ou pré-pagos) */
  hideLimits?: boolean

  // --- Formatação e Moeda ---
  /** Código da moeda (padrão: "BRL") */
  currency?: string
  /** Função customizada de formatação monetária */
  formatAmount?: (value: number) => string

  // --- Ações e Callbacks ---
  /** Callback ao clicar em "Pagar Fatura" */
  onPayInvoice?: () => void
  /** Callback ao clicar em "Extrato PDF" */
  onExportStatement?: () => void
  /** Callback ao copiar o código de barras / linha digitável */
  onCopyBarcode?: () => void
  /** Callback ao copiar a chave / QR Code Pix */
  onCopyPix?: () => void
  /** Callback ao visualizar detalhes da fatura */
  onViewDetails?: () => void
  /** Slot aberto para injetar ações customizadas pelo sistema consumidor */
  actions?: React.ReactNode

  // --- Estado de Carregamento e Estilização ---
  /** Exibe estado de carregamento com esqueletos animados */
  isLoading?: boolean
  /** Classes CSS adicionais do container principal */
  className?: string

  // --- Extensões Reutilizáveis de Domínio (Atlas Design System) ---
  /** Rótulo customizado do botão de pagamento */
  payButtonLabel?: string
  /** Rótulo customizado do botão de exportação */
  exportButtonLabel?: string
  /** Rótulo customizado do botão de detalhes/extrato */
  viewDetailsLabel?: string
  /** Rótulo customizado do badge de status */
  statusBadgeLabel?: string
  /** Valor monetário já formatado em texto (ex: "R$ 1.200,00" ou "—") */
  formattedTotalAmount?: string
  /** Limite total já formatado em texto */
  formattedTotalLimit?: string
  /** Percentual de uso do limite já calculado (0 a 100) */
  usedPercent?: number
  /** Tom visual da barra (primary | amber | destructive) */
  barTone?: LimitBarTone
  /** Texto descritivo do valor para leitores de tela na barra de progresso */
  progressBarAriaText?: string
  /** Label acessível para a barra de progresso */
  progressBarAriaLabel?: string
  /** Nó customizado de badge de status */
  statusBadge?: React.ReactNode
  /** Nó customizado para a identidade do cartão */
  cardIdentityNode?: React.ReactNode
  /** Nó customizado para a linha/informação de vencimento */
  dueDateNode?: React.ReactNode
  /** Texto customizado de intervalo do período (ex: "11/09 a 10/10") */
  periodRangeText?: string
  /** Limite disponível formatado em texto */
  formattedAvailableLimit?: string
  /** Rótulo exibido quando o limite é zero ou indisponível */
  unavailableLimitLabel?: string
  /** Rótulo para o cabeçalho de limite disponível */
  availableLimitLabel?: string
  /** Rótulo para o rodapé de limite total */
  totalLimitLabel?: string
  /** Rótulo / nota de confirmação de todas as faturas pagas */
  allPaidLabel?: string
  /** Texto explicativo / dica abaixo do botão de pagamento */
  payHint?: string
  /** Indica se há faturas no período (habilita/desabilita CTAs no consolidado) */
  hasInvoices?: boolean
}

export function CardInvoiceHeader({
  invoice,
  card,
  cards,
  totalAmount,
  dueDate,
  closingDate,
  period,
  status,
  barcode,
  pixCopyPaste,
  cardNickname,
  last4,
  brand,
  theme,
  isDefault,
  isConsolidated = false,
  limits,
  totalLimit,
  availableLimit,
  usedLimit,
  hideLimits = false,
  currency = "BRL",
  formatAmount,
  onPayInvoice,
  onExportStatement,
  onCopyBarcode,
  onCopyPix,
  onViewDetails,
  actions,
  isLoading = false,
  className,
  payButtonLabel,
  exportButtonLabel,
  viewDetailsLabel,
  statusBadgeLabel,
  formattedTotalAmount,
  formattedTotalLimit,
  formattedAvailableLimit,
  unavailableLimitLabel,
  availableLimitLabel,
  totalLimitLabel,
  allPaidLabel,
  payHint,
  hasInvoices = true,
  usedPercent,
  barTone,
  progressBarAriaText,
  progressBarAriaLabel,
  statusBadge,
  cardIdentityNode,
  dueDateNode,
  periodRangeText,
  ...rest
}: CardInvoiceHeaderProps) {
  // 1. Resolução Unificada dos Dados da Fatura
  const resolvedInvoice = invoice ?? card?.invoices?.find((inv) => inv.status === "closed" || inv.status === "open") ?? card?.invoices?.[0]

  const resolvedStatus: InvoiceStatus | string =
    status ??
    resolvedInvoice?.status ??
    (isConsolidated ? "closed" : "open")

  const resolvedTotalAmount =
    totalAmount ??
    resolvedInvoice?.totalAmount ??
    (isConsolidated && cards
      ? cards.reduce((acc, c) => {
          const inv = c.invoices.find((i) => i.status === "closed" || i.status === "open") || c.invoices[0]
          return acc + (inv?.totalAmount ?? 0)
        }, 0)
      : 0)

  const resolvedDueDate = dueDate ?? resolvedInvoice?.dueDate ?? "A definir"
  const resolvedClosingDate = closingDate ?? resolvedInvoice?.closingDate ?? "A definir"
  const resolvedPeriod = period ?? resolvedInvoice?.period ?? (isConsolidated ? "Fatura Consolidada" : "Fatura Atual")
  const resolvedBarcode = barcode ?? resolvedInvoice?.barcode
  const resolvedPix = pixCopyPaste ?? resolvedInvoice?.pixCopyPaste

  // 2. Resolução da Identidade do Cartão
  const resolvedCardNickname =
    cardNickname ??
    card?.nickname ??
    (isConsolidated ? "Todas as Contas e Cartões" : "Cartão Corporativo")

  const resolvedLast4 = last4 !== undefined ? last4 : card?.last4
  const resolvedBrand = brand ?? card?.brand
  const resolvedTheme = theme ?? card?.theme ?? "midnight"
  const resolvedIsDefault = isDefault ?? card?.isDefault ?? false

  // 3. Resolução dos Limites de Crédito
  const resolvedTotalLimit =
    totalLimit ??
    limits?.totalLimit ??
    card?.limits?.totalLimit ??
    (isConsolidated && cards ? cards.reduce((acc, c) => acc + (c.limits?.totalLimit ?? 0), 0) : undefined)

  const resolvedUsedLimit =
    usedLimit ??
    limits?.usedLimit ??
    card?.limits?.usedLimit ??
    (isConsolidated && cards ? cards.reduce((acc, c) => acc + (c.limits?.usedLimit ?? 0), 0) : undefined)

  const resolvedAvailableLimit =
    availableLimit ??
    limits?.availableLimit ??
    card?.limits?.availableLimit ??
    (resolvedTotalLimit !== undefined && resolvedUsedLimit !== undefined
      ? Math.max(0, resolvedTotalLimit - resolvedUsedLimit)
      : undefined)

  const hasLimits =
    !hideLimits &&
    (usedPercent !== undefined ||
      (resolvedTotalLimit !== undefined && resolvedTotalLimit > 0) ||
      totalLimit !== undefined)

  const calculatedLimitPercent =
    hasLimits && resolvedTotalLimit && resolvedTotalLimit > 0
      ? Math.min(
          100,
          Math.round(
            ((resolvedUsedLimit ?? (resolvedTotalLimit - (resolvedAvailableLimit ?? 0))) /
              resolvedTotalLimit) *
              100
          )
        )
      : 0

  const resolvedPercent = usedPercent !== undefined ? usedPercent : calculatedLimitPercent

  // 4. Formatador Monetário
  const defaultFormatBRL = (val: number) => {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency,
    }).format(val)
  }
  const formatMoney = formatAmount ?? defaultFormatBRL

  // 5. Tom da Barra de Progresso
  const calculatedTone = limitBarTone(resolvedPercent)
  const tone = barTone ?? calculatedTone
  const toneClass =
    tone === "destructive"
      ? "bg-destructive"
      : tone === "amber"
      ? "bg-amber-500"
      : "bg-primary"

  // 6. Handlers de Cópia
  const handleCopyBarcode = () => {
    if (resolvedBarcode) {
      navigator.clipboard?.writeText(resolvedBarcode)
      toast.success("Código de barras / Linha digitável copiada com sucesso!")
    }
    onCopyBarcode?.()
    if (!resolvedBarcode && !onCopyBarcode && onPayInvoice) {
      onPayInvoice()
    }
  }

  const handleCopyPix = () => {
    if (resolvedPix) {
      navigator.clipboard?.writeText(resolvedPix)
      toast.success("Código Pix copia e cola copiado!")
    }
    onCopyPix?.()
  }

  // 7. Badge de Status Semântico Padrão
  const renderStatusBadge = () => {
    switch (resolvedStatus) {
      case "paid":
        return (
          <Badge
            variant="outline"
            className="border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold gap-1 text-xs"
          >
            <CheckCircle2 className="h-3 w-3" />
            {statusBadgeLabel ?? "Paga"}
          </Badge>
        )
      case "closed":
        return (
          <Badge
            variant="default"
            className="bg-amber-600 hover:bg-amber-700 text-white font-semibold gap-1 text-xs shadow-xs"
          >
            <AlertCircle className="h-3 w-3" />
            Fatura Fechada • Vence {resolvedDueDate}
          </Badge>
        )
      case "empty":
        return (
          <Badge
            variant="outline"
            className="border-primary/40 bg-primary/10 text-primary font-semibold gap-1 text-xs"
          >
            <Sparkles className="h-3 w-3" />
            {statusBadgeLabel ?? "Sem faturas"}
          </Badge>
        )
      case "open":
        return (
          <Badge
            variant="outline"
            className="border-primary/40 bg-primary/10 text-primary font-semibold gap-1 text-xs"
          >
            <Sparkles className="h-3 w-3" />
            {statusBadgeLabel ?? "Fatura Atual (Aberta)"}
          </Badge>
        )
      case "future":
        return (
          <Badge variant="secondary" className="text-muted-foreground font-semibold text-xs">
            {statusBadgeLabel ?? "Fatura Futura"}
          </Badge>
        )
      default:
        return (
          <Badge variant="outline" className="text-xs">
            {statusBadgeLabel ?? resolvedStatus}
          </Badge>
        )
    }
  }

  // 8. Loading State
  if (isLoading) {
    return (
      <div
        className={cn(
          "rounded-2xl border border-border/80 bg-card p-5 sm:p-6 shadow-xs text-card-foreground",
          className
        )}
      >
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
          <div className="lg:col-span-5 space-y-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-10 w-48" />
            <Skeleton className="h-4 w-56" />
          </div>
          <div className="lg:col-span-4 rounded-xl border border-border/70 bg-muted/30 p-4 space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="lg:col-span-3 space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "rounded-2xl border border-border/80 bg-card p-5 sm:p-6 shadow-xs text-card-foreground transition-all relative overflow-hidden",
        className
      )}
      {...rest}
    >
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
        {/* Coluna 1: Identidade, Valor da Fatura e Prazos */}
        <div className={cn("space-y-2.5 min-w-0", hasLimits ? "lg:col-span-5" : "lg:col-span-8")}>
          {cardIdentityNode !== undefined ? (
            cardIdentityNode
          ) : isConsolidated ? (
            <div className="flex min-w-0 items-center gap-2">
              {statusBadge !== undefined ? statusBadge : renderStatusBadge()}
              <span className="truncate text-xs font-medium text-muted-foreground">
                {resolvedCardNickname}
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {statusBadge !== undefined ? statusBadge : renderStatusBadge()}

              <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium min-w-0">
                  <div
                    className={cn(
                      "flex h-4 w-6 shrink-0 items-center justify-center rounded border border-white/20 font-mono text-[8px] font-bold text-white shadow-2xs",
                      resolvedTheme === "violet" && "bg-gradient-to-br from-purple-800 to-indigo-950",
                      resolvedTheme === "midnight" && "bg-gradient-to-br from-neutral-800 to-neutral-950",
                      resolvedTheme === "emerald" && "bg-gradient-to-br from-emerald-800 to-teal-950",
                      resolvedTheme === "platinum" && "bg-gradient-to-br from-slate-600 to-slate-900",
                      resolvedTheme === "rose_gold" && "bg-gradient-to-br from-rose-700 to-pink-950"
                    )}
                  >
                    ••••
                  </div>

                <span className="font-semibold text-foreground truncate max-w-[180px]">
                  {resolvedCardNickname}
                </span>

                {resolvedLast4 && (
                  <span className="font-mono text-muted-foreground/80 text-[11px]">
                    (final {resolvedLast4})
                  </span>
                )}

                {resolvedBrand && (
                  <span className="uppercase text-[10px] font-bold px-1.5 py-0.2 rounded bg-muted text-muted-foreground">
                    {resolvedBrand}
                  </span>
                )}

                {resolvedIsDefault && (
                  <span title="Cartão Padrão Principal">
                    <Star className="h-3.5 w-3.5 fill-amber-500 text-amber-500 shrink-0" />
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Valor Principal da Fatura */}
          <div>
            <span className="text-xs text-muted-foreground block font-medium">
              {periodRangeText ?? `Total da Fatura • ${resolvedPeriod}`}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight text-foreground tabular-nums block">
                {formattedTotalAmount ?? formatMoney(resolvedTotalAmount)}
              </span>
              {cardIdentityNode !== undefined && statusBadge !== undefined ? statusBadge : null}
              {allPaidLabel ? (
                <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  {allPaidLabel}
                </span>
              ) : null}
            </div>
          </div>

          {/* Datas de Fechamento e Vencimento */}
          {dueDateNode !== undefined ? (
            dueDateNode
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground pt-0.5">
              <span className="flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5 text-primary" />
                Fechamento: <strong className="text-foreground">{resolvedClosingDate}</strong>
              </span>
              <span className="flex items-center gap-1">
                Vencimento: <strong className="text-foreground">{resolvedDueDate}</strong>
              </span>
              {onViewDetails && (
                <button
                  type="button"
                  onClick={onViewDetails}
                  className="text-primary hover:underline font-semibold ml-auto text-xs cursor-pointer"
                >
                  Ver detalhes
                </button>
              )}
            </div>
          )}
        </div>

        {/* Coluna 2: Barra de Limite de Crédito Utilizado (quando aplicável) */}
        {hasLimits && (
          <div className="lg:col-span-4 min-w-0 rounded-xl border border-border/70 bg-muted/30 p-4 space-y-2.5">
            <div className="flex items-center justify-between text-xs gap-2">
              <span className="font-semibold text-muted-foreground flex items-center gap-1 min-w-0">
                <CreditCard className="h-3.5 w-3.5 text-primary shrink-0" />
                <span className="truncate">{availableLimitLabel ?? progressBarAriaLabel ?? "Limite Disponível:"}</span>
              </span>
              <span className="font-mono font-bold text-foreground tabular-nums shrink-0">
                {resolvedTotalLimit && resolvedTotalLimit > 0
                  ? (formattedAvailableLimit ?? formatMoney(resolvedAvailableLimit ?? 0))
                  : (unavailableLimitLabel ?? "Limite indisponível")}
              </span>
            </div>

            {/* Barra de progresso do limite */}
            {resolvedTotalLimit && resolvedTotalLimit > 0 ? (
              <div className="space-y-1">
                <div
                  className="h-2 w-full rounded-full bg-muted overflow-hidden"
                  role="progressbar"
                  aria-valuenow={resolvedPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuetext={
                    progressBarAriaText ??
                    `${resolvedPercent}% utilizado · ${formattedTotalAmount ?? formatMoney(resolvedTotalAmount)}`
                  }
                  aria-label={progressBarAriaLabel ?? "Limite utilizado"}
                >
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-500 motion-reduce:transition-none",
                      toneClass
                    )}
                    style={{ width: `${resolvedPercent}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground gap-2">
                  <span className="shrink-0 whitespace-nowrap font-mono tabular-nums">{resolvedPercent}% utilizado</span>
                  {formattedTotalLimit !== undefined ? (
                    <span className="shrink-0 whitespace-nowrap">
                      {totalLimitLabel ?? "Limite total"}:{" "}
                      <strong className="font-mono font-semibold tabular-nums text-foreground">
                        {formattedTotalLimit}
                      </strong>
                    </span>
                  ) : resolvedTotalLimit !== undefined ? (
                    <span className="shrink-0 whitespace-nowrap">
                      {totalLimitLabel ?? "Limite total"}:{" "}
                      <strong className="font-mono font-semibold tabular-nums text-foreground">
                        {formatMoney(resolvedTotalLimit)}
                      </strong>
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* Coluna 3: Ações de Pagamento e Exportação */}
        <div
          className={cn(
            "flex flex-col sm:flex-row justify-center gap-2 min-w-0",
            hasLimits ? "lg:col-span-3 lg:flex-col" : "lg:col-span-4 lg:flex-col"
          )}
        >
          {actions ? (
            actions
          ) : isConsolidated ? (
            <>
              <Button
                type="button"
                disabled
                aria-describedby="cards-verdict-pay-hint"
                className="min-h-11 w-full text-xs font-semibold gap-2 shadow-xs bg-primary text-primary-foreground disabled:opacity-50"
              >
                <Receipt className="h-4 w-4" />
                <span>{payButtonLabel ?? "Pagar fatura"}</span>
              </Button>
              <p id="cards-verdict-pay-hint" className="text-[11px] text-muted-foreground text-center">
                {payHint ?? "Selecione um cartão para pagar"}
              </p>
              <div className="grid grid-cols-2 gap-2 w-full">
                {onExportStatement && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={hasInvoices === false}
                    onClick={onExportStatement}
                    className="min-h-11 w-full gap-1 whitespace-nowrap px-2 text-[11px] font-semibold cursor-pointer"
                    title="Exportar demonstrativo detalhado da fatura em CSV"
                  >
                    <Download className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{exportButtonLabel ?? "Exportar CSV"}</span>
                  </Button>
                )}
                {onViewDetails && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={hasInvoices === false}
                    onClick={onViewDetails}
                    className="min-h-11 w-full gap-1 whitespace-nowrap px-2 text-[11px] font-semibold text-muted-foreground hover:text-foreground cursor-pointer"
                    title={viewDetailsLabel ?? "Ver lançamentos"}
                  >
                    <List className="h-3.5 w-3.5" />
                    <span>{viewDetailsLabel ?? "Ver lançamentos"}</span>
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              {onPayInvoice && (
                <Button
                  type="button"
                  onClick={onPayInvoice}
                  disabled={resolvedStatus === "paid"}
                  className="min-h-11 w-full text-xs font-semibold gap-2 shadow-xs bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer disabled:opacity-50"
                >
                  <QrCode className="h-4 w-4" />
                  <span>{payButtonLabel ?? "Pagar Fatura (Pix / Boleto)"}</span>
                </Button>
              )}

              <div className="flex items-center gap-2">
                {onExportStatement && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onExportStatement}
                    className="min-h-11 flex-1 text-xs font-semibold gap-1.5 cursor-pointer"
                    title="Exportar demonstrativo detalhado da fatura em PDF"
                  >
                    <Download className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{exportButtonLabel ?? "Extrato PDF"}</span>
                  </Button>
                )}

                {(resolvedBarcode || onCopyBarcode || onViewDetails || onPayInvoice) && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={onViewDetails ?? handleCopyBarcode}
                    className="min-h-11 flex-1 text-xs font-semibold gap-1 text-muted-foreground hover:text-foreground cursor-pointer"
                    title={viewDetailsLabel ?? (resolvedBarcode ? "Copiar linha digitável do boleto" : "Ver detalhes")}
                  >
                    {onViewDetails ? (
                      <Receipt className="h-3.5 w-3.5" />
                    ) : resolvedBarcode ? (
                      <Copy className="h-3.5 w-3.5" />
                    ) : (
                      <Receipt className="h-3.5 w-3.5" />
                    )}
                    <span>{viewDetailsLabel ?? (resolvedBarcode ? "Linha Digitável" : "Ver detalhes")}</span>
                  </Button>
                )}

                {resolvedPix && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleCopyPix}
                    className="min-h-11 flex-1 text-xs font-semibold gap-1 text-muted-foreground hover:text-foreground cursor-pointer"
                    title="Copiar código Pix Copia e Cola"
                  >
                    <QrCode className="h-3.5 w-3.5 text-emerald-600" />
                    <span>Copiar Pix</span>
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
