import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Clock, Hourglass } from 'lucide-react'
import { Badge } from '@/components/shadcn/ui/badge'
import { formatCentsBRL } from '@/lib/utils'
import type { InvoiceDisplayStatus } from '../model/credit-card'

interface InvoiceStatusBadgeProps {
  status: InvoiceDisplayStatus
  remainingCents?: number
}

// Badge de status da fatura: cor 10% + borda 40% + ícone (nunca só cor — WCAG).
export function InvoiceStatusBadge({ status, remainingCents = 0 }: InvoiceStatusBadgeProps) {
  const { t } = useTranslation()

  if (status === 'paid') {
    return (
      <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 data-icon="inline-start" />
        {t('cards.status.paid')}
      </Badge>
    )
  }

  if (status === 'overdue') {
    return (
      <Badge className="border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400">
        <AlertTriangle data-icon="inline-start" />
        {t('cards.status.overdue')}
      </Badge>
    )
  }

  if (status === 'partial') {
    return (
      <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <Hourglass data-icon="inline-start" />
        <span className="font-mono tabular-nums">
          {t('cards.status.partial')} · {formatCentsBRL(remainingCents)}
        </span>
      </Badge>
    )
  }

  if (status === 'closed') {
    return (
      <Badge className="border-primary/30 bg-primary/10 text-primary">
        <Clock data-icon="inline-start" />
        {t('cards.status.closed')}
      </Badge>
    )
  }

  return (
    <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
      <Clock data-icon="inline-start" />
      {t('cards.status.open')}
    </Badge>
  )
}
