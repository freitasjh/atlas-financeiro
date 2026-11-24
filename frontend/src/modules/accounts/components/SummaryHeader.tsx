import { useTranslation } from 'react-i18next'
import {
  Landmark,
  ArrowLeftRight,
  Upload,
  RefreshCw,
  TrendingUp,
  Lock,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
} from 'lucide-react'
import { Button } from '@/components/shadcn/ui/button'
import { Badge } from '@/components/shadcn/ui/badge'
import { cn } from '@/lib/cn'
import { formatCentsBRL } from '@/lib/utils'
import {
  institutionInfo,
  type AccountType,
  type AccountViewItem,
  type TreasuryMetricsCents,
} from '../model/view-model'

const TYPE_LABEL_KEY: Record<AccountType, string> = {
  checking: 'accounts.summary.typeChecking',
  savings: 'accounts.summary.typeSavings',
  investment: 'accounts.summary.typeInvestment',
  wallet: 'accounts.summary.typeWallet',
  physical_cash: 'accounts.summary.typePhysicalCash',
}

interface SummaryHeaderProps {
  account: AccountViewItem | null
  metrics: TreasuryMetricsCents
  onOpenTransfer: () => void
  onOpenImportOFX: () => void
  onSyncAccount?: () => void
  className?: string
}

function bankLine(
  t: (key: string, options?: Record<string, unknown>) => string,
  account: AccountViewItem,
): string {
  if (account.agency === '---') {
    return t('accounts.bankLineNoAgency', { account: account.accountNumber, digit: account.accountDigit })
  }
  return t('accounts.bankLine', {
    agency: account.agency,
    account: account.accountNumber,
    digit: account.accountDigit,
  })
}

export function SummaryHeader({
  account,
  metrics,
  onOpenTransfer,
  onOpenImportOFX,
  onSyncAccount,
  className,
}: SummaryHeaderProps) {
  const { t } = useTranslation()

  const currentBalanceCents = account ? account.currentBalanceCents : metrics.totalConsolidatedBalanceCents
  const currentBlockedCents = account ? account.blockedBalanceCents : metrics.totalBlockedBalanceCents
  const institution = account ? institutionInfo(account.institution) : null
  const hasProjections = metrics.hasProjections

  return (
    <div className={cn('rounded-2xl border border-border/80 bg-card p-5 sm:p-6 shadow-xs text-card-foreground', className)}>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
        <div className={hasProjections ? 'lg:col-span-5 space-y-2' : 'lg:col-span-7 space-y-2'}>
          <div className="flex items-center gap-2">
            {institution ? (
              <Badge variant="outline" className={`text-[11px] font-semibold gap-1 border shadow-2xs ${institution.lightBg}`}>
                <span>{institution.name || account?.nickname}</span>
                {institution.compe !== '---' && <span className="opacity-75 font-mono tabular-nums">({institution.compe})</span>}
              </Badge>
            ) : (
              <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary font-semibold gap-1 text-[11px]">
                <Landmark className="h-3 w-3" />
                {t('accounts.summary.consolidatedBadge')}
              </Badge>
            )}

            <span className="text-xs text-muted-foreground font-medium">
              {account ? account.nickname : t('accounts.summary.generalBalance')}
            </span>
          </div>

          <div>
            <span className="text-xs text-muted-foreground block font-medium">
              {account ? t(TYPE_LABEL_KEY[account.type]) : t('accounts.summary.consolidatedView')}
            </span>
            <span className="font-mono text-3xl sm:text-4xl font-extrabold tracking-tight text-foreground block tabular-nums">
              {formatCentsBRL(currentBalanceCents)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground pt-0.5">
            {account ? (
              <>
                <span className="font-mono tabular-nums">{bankLine(t, account)}</span>
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                  {t(`accounts.sync.${account.connectionStatus}`)}
                </span>
              </>
            ) : (
              <span className="flex items-center gap-1">
                <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
                {t('accounts.noYield')}
              </span>
            )}
          </div>

          {!hasProjections && (
            <p className="text-[11px] text-muted-foreground">{t('accounts.metrics.projectionsUnavailable')}</p>
          )}
        </div>

        {hasProjections && (
        <div className="lg:col-span-4 rounded-xl border border-border/70 bg-muted/30 p-4 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-muted-foreground flex items-center gap-1">
                  <TrendingUp className="h-3.5 w-3.5 text-primary" />
                  {t('accounts.summary.projection')}
                </span>
                {currentBlockedCents > 0 && (
                  <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400 font-mono tabular-nums">
                    <Lock className="h-3 w-3" /> {t('accounts.summary.blockedInline', { value: formatCentsBRL(currentBlockedCents) })}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-background p-2 border border-border/60">
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1 mb-0.5">
                    <ArrowDownLeft className="h-3 w-3 text-emerald-600" /> {t('accounts.summary.inflow')}
                  </span>
                  <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400 tabular-nums text-xs">
                    + {formatCentsBRL(metrics.projectedInflow15DaysCents)}
                  </span>
                </div>

                <div className="rounded-lg bg-background p-2 border border-border/60">
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1 mb-0.5">
                    <ArrowUpRight className="h-3 w-3 text-destructive" /> {t('accounts.summary.outflow')}
                  </span>
                  <span className="font-mono font-bold text-foreground tabular-nums text-xs">
                    - {formatCentsBRL(metrics.projectedOutflow15DaysCents)}
                  </span>
                </div>
              </div>
        </div>
        )}

        <div
          className={cn(
            'flex flex-col sm:flex-row lg:flex-col justify-center gap-2',
            hasProjections ? 'lg:col-span-3' : 'lg:col-span-5',
          )}
        >
          <Button
            type="button"
            onClick={onOpenTransfer}
            className="h-10 text-xs font-semibold gap-2 shadow-xs min-h-11"
          >
            <ArrowLeftRight className="h-4 w-4" />
            <span>{t('accounts.summary.transferCta')}</span>
          </Button>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenImportOFX}
              className="flex-1 text-xs font-semibold gap-1.5 h-9 min-h-11"
            >
              <Upload className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{t('accounts.summary.importOfx')}</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onSyncAccount?.()}
              aria-label={t('accounts.metrics.syncTitle')}
              title={t('accounts.metrics.syncTitle')}
              className="flex-1 text-xs font-semibold gap-1 text-muted-foreground hover:text-foreground h-9 min-h-11"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{t('accounts.summary.sync')}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
