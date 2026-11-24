import { useTranslation } from 'react-i18next'
import { Pencil, Star, Trash2 } from 'lucide-react'
import { Badge } from '@/components/shadcn/ui/badge'
import { Button } from '@/components/shadcn/ui/button'
import { Card, CardContent } from '@/components/shadcn/ui/card'
import { cn } from '@/lib/cn'
import { formatCentsBRL } from '@/lib/utils'
import { displayInvoiceStatus, type CreditCardView } from '../model/credit-card'
import type { InvoiceRow } from '../service/credit-cards.service'
import { CreditCardPreview } from './CreditCardPreview'
import { InvoiceStatusBadge } from './InvoiceStatusBadge'
import { cardBrandLabel } from './card-brand'

interface CardsWalletGridProps {
  cards: CreditCardView[]
  selectedCardId: string
  invoicesByCard: Record<string, InvoiceRow[]>
  periodCode: string | null
  principalCardId: string | null
  onSelect: (id: string) => void
  onSetPrincipal: (id: string) => void
  onEdit: (card: CreditCardView) => void
  onDelete: (card: CreditCardView) => void
}

// Carteira completa: grid de cartões 3D + Definir principal/Editar/Excluir.
export function CardsWalletGrid({
  cards,
  selectedCardId,
  invoicesByCard,
  periodCode,
  principalCardId,
  onSelect,
  onSetPrincipal,
  onEdit,
  onDelete,
}: CardsWalletGridProps) {
  const { t } = useTranslation()

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((cardItem) => {
        const invoice = periodCode
          ? (invoicesByCard[cardItem.id] ?? []).find((inv) => inv.period_start.startsWith(periodCode))
          : undefined
        const status = invoice ? displayInvoiceStatus(invoice) : null
        const isSelected = cardItem.id === selectedCardId
        const isPrincipal = cardItem.id === principalCardId
        return (
          <Card
            key={cardItem.id}
            className={cn(
              'border-border/70 shadow-xs transition-transform motion-safe:hover:-translate-y-0.5',
              isSelected && 'border-primary ring-1 ring-primary/20',
            )}
          >
            <CardContent className="flex flex-col gap-3 p-4 sm:p-5">
              <div className="flex justify-center pb-1">
                <CreditCardPreview
                  variant="wallet"
                  last4={cardItem.last4 ?? null}
                  holderName={cardItem.holderName ?? null}
                  expiry={cardItem.expiryMmAA ?? null}
                  theme={cardItem.theme}
                  brand={cardItem.brand}
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <div className="flex items-center gap-1.5">
                  {isPrincipal ? (
                    <Badge className="border-primary/30 bg-primary/10 text-primary">
                      <Star data-icon="inline-start" />
                      {t('cards.wallet.principal')}
                    </Badge>
                  ) : null}
                  {status ? (
                    <InvoiceStatusBadge status={status} remainingCents={invoice ? Math.max(invoice.total_cents - invoice.paid_cents, 0) : 0} />
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onSelect(cardItem.id)}
                aria-pressed={isSelected}
                className="flex min-w-0 cursor-pointer flex-col items-start gap-0.5 text-left"
              >
                <span className="w-full truncate text-sm font-bold text-foreground">{cardItem.nickname}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[11px] font-medium text-muted-foreground">
                    {cardBrandLabel(cardItem.brand, t('cards.brandOther'))}
                  </span>
                </span>
              </button>
              <div className="flex items-baseline justify-between gap-2 border-t border-border/60 pt-3">
                <div className="flex min-w-0 flex-col">
                  <span className="text-[11px] font-medium text-muted-foreground">{t('cards.invoice.total')}</span>
                  <span className="font-mono text-lg font-bold tabular-nums text-foreground">
                    {invoice ? formatCentsBRL(invoice.total_cents) : t('cards.period.noValue')}
                  </span>
                </div>
                <div className="flex shrink-0 flex-col items-end">
                  <span className="text-[11px] font-medium text-muted-foreground">{t('cards.limitGauge.total')}</span>
                  <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                    {formatCentsBRL(cardItem.limitCents)}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!isPrincipal ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onSetPrincipal(cardItem.id)}
                    className="min-h-11 gap-1 text-xs"
                  >
                    <Star data-icon="inline-start" />
                    {t('cards.wallet.setPrincipal')}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onEdit(cardItem)}
                  className="min-h-11 gap-1 text-xs"
                >
                  <Pencil data-icon="inline-start" />
                  {t('cards.edit')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(cardItem)}
                  className="min-h-11 gap-1 text-xs text-destructive hover:text-destructive"
                >
                  <Trash2 data-icon="inline-start" />
                  {t('cards.remove')}
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
