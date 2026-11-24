import { useTranslation } from 'react-i18next'
import { Calendar, CreditCard } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/ui/dialog'
import { Badge } from '@/components/shadcn/ui/badge'
import { Button } from '@/components/shadcn/ui/button'
import { formatCentsBRL } from '@/lib/utils'
import type { ExpenseRow } from '@/components/shadcn/credit-card/card-expenses-table'

interface ExpenseDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  expense: ExpenseRow | null
}

export function ExpenseDetailDialog({ open, onOpenChange, expense }: ExpenseDetailDialogProps) {
  const { t, i18n } = useTranslation()
  const last4 = expense?.cardLast4
  const hasLast4 = typeof last4 === 'string' && /^\d{4}$/.test(last4)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[92vh] w-full overflow-y-auto overscroll-contain p-5 sm:max-w-md sm:p-6"
      >
        <DialogHeader className="min-w-0">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <Badge variant="outline" className="min-w-0 max-w-[45%] truncate text-xs font-semibold">
              <span className="truncate">{expense?.categoryName ?? t('cards.purchase.noCategory')}</span>
            </Badge>
            <span className="min-w-0 truncate font-mono text-[11px] tabular-nums text-muted-foreground">
              {t('cards.detail.id')}: {expense?.id ?? ''}
            </span>
          </div>
          <DialogTitle className="mt-2 min-w-0 truncate text-left text-lg font-bold tracking-tight text-foreground">
            {expense?.description ?? t('cards.detail.title')}
          </DialogTitle>
          <DialogDescription className="min-w-0 text-left text-xs">
            {hasLast4
              ? t('cards.detail.processedOnCard', { last4 })
              : t('cards.detail.processedOnCardUnknown')}
          </DialogDescription>
        </DialogHeader>

        {expense ? (
          <div className="flex min-w-0 flex-col gap-5">
            <div className="rounded-xl border border-border/80 bg-muted/30 p-4 text-center">
              <span className="block text-xs text-muted-foreground">{t('cards.detail.amountLabel')}</span>
              <span className="mt-0.5 block font-mono text-2xl font-extrabold tabular-nums text-foreground">
                {formatCentsBRL(expense.amountCents, i18n.language)}
              </span>
              {expense.installmentLabel ? (
                <Badge variant="secondary" className="mt-2 text-[10px] font-semibold">
                  {t('cards.detail.installmentBadge', { label: expense.installmentLabel })}
                </Badge>
              ) : null}
            </div>

            <section className="min-w-0 space-y-2.5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                {t('cards.detail.dataSection')}
              </h4>
              <dl className="space-y-2.5 rounded-xl border border-border/70 p-3.5 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-muted-foreground">
                    <Calendar className="size-3.5 text-primary" aria-hidden="true" />
                    {t('cards.detail.date')}
                  </dt>
                  <dd className="font-mono font-semibold tabular-nums text-foreground">{expense.date}</dd>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-muted-foreground">
                    <CreditCard className="size-3.5 text-primary" aria-hidden="true" />
                    {t('cards.detail.cardUsed')}
                  </dt>
                  <dd className="font-mono font-bold tabular-nums text-foreground">
                    {hasLast4 ? `•••• ${last4}` : '••••'}
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        ) : null}

        <DialogFooter className="mt-5 flex flex-row items-center justify-end gap-3 sm:space-x-0">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="min-h-11">
            {t('cards.detail.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
