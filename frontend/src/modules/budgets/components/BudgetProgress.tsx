import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/shadcn/ui/badge'
import { formatCentsBRL, cn } from '@/lib/utils'
import { budgetStatus, type BudgetStatus } from '../model/budget.adapter'

// O2.3 — barra gasto-vs-teto: h-2 rounded-full, cor + ícone + texto por
// status (nunca só cor), valores em tabular-nums, progressbar com aria.

const BAR_CLASS: Record<BudgetStatus, string> = {
  ok: 'bg-emerald-500',
  warning: 'bg-amber-500',
  over: 'bg-rose-500',
}

const BADGE_CLASS: Record<BudgetStatus, string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  over: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
}

const STATUS_ICON = {
  ok: CheckCircle2,
  warning: AlertTriangle,
  over: AlertCircle,
} as const

interface BudgetProgressProps {
  spentCents: number
  limitCents: number
}

export function BudgetProgress({ spentCents, limitCents }: BudgetProgressProps) {
  const { t, i18n } = useTranslation()
  const status = budgetStatus(spentCents, limitCents)

  // Percentual de exibição: inteiro arredondado (display, não dinheiro).
  const percent = limitCents === 0 ? 0 : Math.round((spentCents * 100) / limitCents)
  const clamped = Math.min(100, Math.max(0, percent))
  // band usa `warn` (status usa `warning`) — chaves budgets.band.* existentes.
  const statusText = t(`budgets.band.${status === 'warning' ? 'warn' : status}`)
  const StatusIcon = STATUS_ICON[status]

  const amounts = useMemo(
    () => ({
      spent: formatCentsBRL(spentCents, i18n.language),
      limit: formatCentsBRL(limitCents, i18n.language),
    }),
    [spentCents, limitCents, i18n.language],
  )

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate font-mono font-semibold tabular-nums text-foreground">
          {amounts.spent}
          <span className="font-normal text-muted-foreground"> / {amounts.limit}</span>
        </span>
        <Badge variant="outline" className={cn('shrink-0 gap-1 text-[11px]', BADGE_CLASS[status])}>
          <StatusIcon className="size-3" aria-hidden="true" />
          {statusText}
        </Badge>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-label={t('budgets.progressAria', {
          spent: amounts.spent,
          limit: amounts.limit,
          percent,
          status: statusText,
        })}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={cn('h-2 rounded-full transition-colors', BAR_CLASS[status])} style={{ width: `${clamped}%` }} />
      </div>
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{percent}%</span>
    </div>
  )
}
