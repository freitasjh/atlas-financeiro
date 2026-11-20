import { useRef } from "react"
import { useTranslation } from "react-i18next"
import { Plus, Star, CreditCard, ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/shadcn/ui/button"
import { cn } from "@/lib/cn"
import { formatCentsBRL } from "@/lib/utils"
import type { CardTheme } from "./credit-card-types"
import type { CardWithInvoices } from "./statement-types"

export type CardSelectorStatus = "open" | "closed" | "paid" | "future" | "overdue" | "partial"

/** Contrato de dados do seletor: todo valor monetário entra em BIGINT cents. */
export interface CardSelectorCard {
  id: string
  nickname: string
  last4?: string | null
  theme?: CardTheme
  isDefault?: boolean
  amountCents: number
  status?: CardSelectorStatus | null
}

interface CardSelectorBarProps {
  cards: CardWithInvoices[] | CardSelectorCard[]
  selectedCardId: string
  totalConsolidatedCents?: number
  onSelectCard: (cardId: string) => void
  onAddNewCard: () => void
  className?: string
}

function dotClass(status: CardSelectorStatus): string {
  if (status === "paid") return "bg-emerald-500"
  if (status === "overdue") return "bg-rose-500"
  return "bg-amber-500"
}

function toSelectorCard(card: CardWithInvoices | CardSelectorCard): CardSelectorCard {
  if (!("invoices" in card)) return card
  const currentInvoice =
    card.invoices.find((inv) => inv.status === "closed" || inv.status === "open") ||
    card.invoices[0]
  return {
    id: card.id,
    nickname: card.nickname,
    last4: card.last4,
    theme: card.theme,
    isDefault: card.isDefault,
    amountCents: currentInvoice?.totalCents ?? 0,
    status: currentInvoice?.status,
  }
}

export function CardSelectorBar({
  cards,
  selectedCardId,
  totalConsolidatedCents = 0,
  onSelectCard,
  onAddNewCard,
  className,
}: CardSelectorBarProps) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const selectorCards = cards.map(toSelectorCard)

  const scrollCarousel = (direction: "left" | "right") => {
    if (scrollRef.current) {
      const scrollAmount = direction === "left" ? -300 : 300
      scrollRef.current.scrollBy({ left: scrollAmount, behavior: "smooth" })
    }
  }

  const isConsolidatedSelected = selectedCardId === ""

  return (
    <div className={cn("relative flex items-center gap-2 w-full", className)}>
      {/* 1. Botão Fixo de Adicionar Novo Cartão (Sempre Visível no Início) */}
      <Button
        type="button"
        size="sm"
        onClick={onAddNewCard}
        className="h-[52px] px-3.5 text-xs font-semibold gap-2 border border-dashed border-primary/50 bg-primary/5 hover:bg-primary/10 text-primary shrink-0 rounded-xl shadow-2xs transition-all hover:border-primary cursor-pointer"
        title={t("cards.new")}
      >
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shrink-0 shadow-xs">
          <Plus className="h-4 w-4" />
        </div>
        <span className="hidden sm:inline font-bold">{t("cards.new")}</span>
      </Button>

      {/* Divisor Visual Sutil */}
      <div className="h-8 w-px bg-border/70 shrink-0 hidden sm:block" />

      {/* 2. Chip Fixo / Destacado de Fatura Consolidada */}
      <button
        type="button"
        onClick={() => onSelectCard("")}
        className={cn(
          "flex items-center gap-2.5 px-3.5 py-2 h-[52px] rounded-xl border text-left transition-all shrink-0 cursor-pointer shadow-2xs",
          isConsolidatedSelected
            ? "border-primary bg-primary/10 ring-1 ring-primary/30"
            : "border-border/80 bg-card hover:bg-muted/50 hover:border-border"
        )}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary shrink-0">
          <CreditCard className="h-4 w-4" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-bold text-foreground leading-tight">
            {t("cards.selector.consolidated")}
          </span>
          <span className="font-mono text-xs font-bold text-foreground tabular-nums">
            {formatCentsBRL(totalConsolidatedCents)}
          </span>
        </div>
      </button>

      {/* 3. Controles de Rolagem do Carrossel (Esquerda/Direita) */}
      <div className="flex items-center gap-1 shrink-0">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => scrollCarousel("left")}
          className="h-8 w-8 rounded-lg border-border/80 hover:bg-muted shrink-0 text-muted-foreground hover:text-foreground cursor-pointer shadow-2xs"
          title={t("cards.selector.scrollLeft")}
        >
          <ChevronLeft className="h-4 w-4" />
          <span className="sr-only">{t("cards.selector.scrollLeft")}</span>
        </Button>
      </div>

      {/* 4. Trilho Rolável dos Cartões (Carrossel) */}
      <div
        ref={scrollRef}
        data-testid="cards-chips"
        className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none snap-x flex-1 min-w-0"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        {selectorCards.map((card) => {
          const isSelected = card.id === selectedCardId

          return (
            <button
              key={card.id}
              type="button"
              onClick={() => onSelectCard(card.id)}
              className={cn(
                "group relative flex items-center gap-2.5 px-3 py-2 h-[52px] rounded-xl border text-left transition-all shrink-0 cursor-pointer shadow-2xs snap-start",
                isSelected
                  ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                  : "border-border/80 bg-card hover:bg-muted/50 hover:border-border"
              )}
            >
              {/* Mini cartão temático estilizado */}
              <div
                className={cn(
                  "flex h-8 w-11 shrink-0 items-center justify-center rounded-lg border border-white/20 font-mono text-[9px] font-bold text-white shadow-2xs",
                  card.theme === "violet" && "bg-gradient-to-br from-purple-800 to-indigo-950",
                  card.theme === "midnight" && "bg-gradient-to-br from-neutral-800 to-neutral-950",
                  card.theme === "emerald" && "bg-gradient-to-br from-emerald-800 to-teal-950",
                  card.theme === "platinum" && "bg-gradient-to-br from-slate-600 to-slate-900",
                  card.theme === "rose_gold" && "bg-gradient-to-br from-rose-700 to-pink-950"
                )}
              >
                ••••
              </div>

              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-foreground truncate max-w-[130px]">
                    {card.nickname}
                  </span>
                  {card.status ? (
                    <span
                      aria-hidden="true"
                      className={cn("size-2 shrink-0 rounded-full", dotClass(card.status))}
                    />
                  ) : null}
                  {card.isDefault && (
                    <span title={t("cards.wallet.principal")}>
                      <Star className="h-3 w-3 fill-amber-500 text-amber-500 shrink-0" />
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs font-bold text-foreground tabular-nums">
                    {formatCentsBRL(card.amountCents)}
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground uppercase">
                    • {card.last4 ?? "••••"}
                  </span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Botão de Rolagem Direita */}
      <div className="flex items-center shrink-0">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => scrollCarousel("right")}
          className="h-8 w-8 rounded-lg border-border/80 hover:bg-muted shrink-0 text-muted-foreground hover:text-foreground cursor-pointer shadow-2xs"
          title={t("cards.selector.scrollRight")}
        >
          <ChevronRight className="h-4 w-4" />
          <span className="sr-only">{t("cards.selector.scrollRight")}</span>
        </Button>
      </div>
    </div>
  )
}
