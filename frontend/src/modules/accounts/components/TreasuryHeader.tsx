import { useTranslation } from 'react-i18next'
import { RefreshCw, Plus, ArrowLeftRight, Upload, Lock, TrendingUp, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/shadcn/ui/button'
import { formatCentsBRL } from '@/lib/utils'
import type { TreasuryMetricsCents } from '../model/view-model'

interface TreasuryHeaderProps {
  metrics: TreasuryMetricsCents
  accountsCount: number
  /** D3: esconde o CTA quando o empty state já oferece a criação. */
  hideNewAccountAction?: boolean
  onOpenNewAccount: () => void
  onOpenTransfer: () => void
  onOpenImportOFX: () => void
  onSyncAll?: () => void
}

export function TreasuryHeader({
  metrics,
  accountsCount,
  hideNewAccountAction = false,
  onOpenNewAccount,
  onOpenTransfer,
  onOpenImportOFX,
  onSyncAll,
}: TreasuryHeaderProps) {
  const { t } = useTranslation()

  const countLabel =
    accountsCount === 0
      ? t('accounts.countLabelZero')
      : t(accountsCount === 1 ? 'accounts.countLabel_one' : 'accounts.countLabel_other', { count: accountsCount })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/70 pb-4">
        <p className="text-xs text-muted-foreground tabular-nums">{countLabel}</p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onSyncAll?.()}
            aria-label={t('accounts.metrics.syncTitle')}
            title={t('accounts.metrics.syncTitle')}
            className="h-9 text-xs font-semibold gap-1.5 border-border/80 text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="hidden sm:inline">{t('accounts.metrics.sync')}</span>
            {` ${t('accounts.openFinance')}`}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenImportOFX}
            className="h-9 text-xs font-semibold gap-1.5 border-border/80 text-foreground"
          >
            <Upload className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{t('accounts.metrics.importOfx')}</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenTransfer}
            className="h-9 text-xs font-semibold gap-1.5 border-border/80 text-foreground"
          >
            <ArrowLeftRight className="h-3.5 w-3.5 text-primary" />
            <span>{t('accounts.metrics.transfer')}</span>
          </Button>

          {!hideNewAccountAction && (
            <Button
              type="button"
              size="sm"
              onClick={onOpenNewAccount}
              className="h-9 text-xs font-bold gap-1.5 bg-primary text-primary-foreground shadow-xs"
            >
              <Plus className="h-4 w-4" />
              <span>{t('accounts.metrics.newAccount')}</span>
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-2xs text-card-foreground">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span className="font-medium">{t('accounts.metrics.consolidated')}</span>
          </div>
          <span className="font-mono text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground block tabular-nums">
            {formatCentsBRL(metrics.totalConsolidatedBalanceCents)}
          </span>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-2 pt-2 border-t border-border/60">
            <span>
              {t('accounts.metrics.available')}{' '}
              <strong className="text-foreground font-mono tabular-nums">
                {formatCentsBRL(metrics.totalAvailableBalanceCents)}
              </strong>
            </span>
            {metrics.totalBlockedBalanceCents > 0 && (
              <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400 tabular-nums">
                <Lock className="h-3 w-3" />
                {t('accounts.metrics.blocked')}: {formatCentsBRL(metrics.totalBlockedBalanceCents)}
              </span>
            )}
          </div>
        </div>

        {metrics.hasProjections ? (
          <>
            <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-2xs text-card-foreground">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <span className="font-medium">{t('accounts.metrics.inflow15')}</span>
                <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
                  <ArrowDownLeft className="h-3.5 w-3.5" />
                </div>
              </div>
              <span className="font-mono text-2xl font-extrabold tracking-tight text-emerald-600 dark:text-emerald-400 block tabular-nums">
                + {formatCentsBRL(metrics.projectedInflow15DaysCents)}
              </span>
              <p className="text-[11px] text-muted-foreground mt-2 pt-2 border-t border-border/60">
                {t('accounts.metrics.inflowHint')}
              </p>
            </div>

            <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-2xs text-card-foreground">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <span className="font-medium">{t('accounts.metrics.outflow15')}</span>
                <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </div>
              </div>
              <span className="font-mono text-2xl font-extrabold tracking-tight text-foreground block tabular-nums">
                - {formatCentsBRL(metrics.projectedOutflow15DaysCents)}
              </span>
              <p className="text-[11px] text-muted-foreground mt-2 pt-2 border-t border-border/60">
                {t('accounts.metrics.outflowHint')}
              </p>
            </div>

            <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-2xs text-card-foreground">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <span className="font-medium">{t('accounts.metrics.yield')}</span>
                <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <TrendingUp className="h-3.5 w-3.5" />
                </div>
              </div>
              <span className="font-mono text-2xl font-extrabold tracking-tight text-foreground block tabular-nums">
                + {formatCentsBRL(metrics.monthYieldCDICents)}
              </span>
              <p className="text-[11px] text-muted-foreground mt-2 pt-2 border-t border-border/60 tabular-nums">
                {t('accounts.yieldHint', { percentage: metrics.yieldPercentageCDI })}
              </p>
            </div>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground sm:col-span-2 lg:col-span-3 self-center">
            {t('accounts.metrics.projectionsUnavailable')}
          </p>
        )}
      </div>
    </div>
  )
}
