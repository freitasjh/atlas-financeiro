import { CreditCard, FileDown, PiggyBank, Receipt } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { MoneyValue } from '@/components/ui/money-value'
import { formatCentsBRL, cn } from '@/lib/utils'
import { limitBand, limitBps, usedPercent } from '@/lib/limit-band'
import { FeatureCard } from './FeatureCard'

export interface BentoGridProps {
  usedCents?: number
  limitCents?: number
}

const FEATURES = [
  { icon: Receipt, titleKey: 'landing.feature1Title', descKey: 'landing.feature1Desc' },
  { icon: CreditCard, titleKey: 'landing.feature2Title', descKey: 'landing.feature2Desc' },
  { icon: PiggyBank, titleKey: 'landing.feature3Title', descKey: 'landing.feature3Desc' },
  {
    icon: FileDown,
    titleKey: 'landing.feature4Title',
    descKey: 'landing.feature4Desc',
    badgeKey: 'landing.exportSoon',
    badgeTestId: 'landing-export-soon',
  },
] as const

const BAND_FILL: Record<string, string> = {
  ok: 'bg-emerald-500',
  warning: 'bg-[var(--color-amber-500)]',
  critical: 'bg-rose-500',
  over: 'bg-rose-600',
}

const BAND_LABEL_KEY: Record<string, string> = {
  ok: 'landing.showcaseGaugeBandOk',
  warning: 'landing.showcaseGaugeBandWarning',
  critical: 'landing.showcaseGaugeBandCritical',
  over: 'landing.showcaseGaugeBandOver',
}

function isValidCents(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

// FE-03 — bento 12col: tile-8 Orçamentos gauge + 4 FEATURES reaproveitadas.
// Grid 1col mobile / 2col sm / 12col lg; spans 8 + 4/4/4/4; hover elevado com
// reduced-motion; dinheiro só BIGINT cents; âmbar só via token var.
export function BentoGrid({ usedCents = 45230, limitCents = 80000 }: BentoGridProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language ?? 'pt-BR'
  const gaugeValid = isValidCents(usedCents) && isValidCents(limitCents)
  const gaugeNoLimit = gaugeValid && limitCents === 0
  const gaugeReady = gaugeValid && limitCents > 0
  const bps = gaugeReady ? limitBps(usedCents, limitCents) : null
  const band = gaugeReady ? limitBand(usedCents, limitCents) : null
  const percent = bps === null ? 0 : Math.round(usedPercent(bps))
  const clamped = Math.min(100, Math.max(0, percent))
  const available = gaugeReady ? Math.max(limitCents - usedCents, 0) : 0
  const gaugeText = gaugeReady
    ? t('landing.showcaseGaugeAria', {
        used: formatCentsBRL(usedCents, locale),
        available: formatCentsBRL(available, locale),
        total: formatCentsBRL(limitCents, locale),
        percent,
        band: t(BAND_LABEL_KEY[band ?? 'ok']),
        interpolation: { escapeValue: false },
      })
    : ''

  return (
    <ul data-testid="bento-grid" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-12">
      <li className="sm:col-span-2 lg:col-span-8">
        <div className="flex h-full flex-col gap-3 rounded-2xl border border-border/80 bg-card p-6 shadow-2xs transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-md motion-reduce:transition-none sm:p-7 text-card-foreground">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-lg font-bold tracking-tight text-foreground">{t('landing.showcaseBudgetsTitle')}</h3>
            <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-[11px] font-bold tracking-widest text-primary">
              {t('landing.showcaseDemoBadge')}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{t('landing.feature3Desc')}</p>
          {!gaugeValid ? (
            <p role="status" className="text-xs font-medium text-destructive">
              {t('landing.showcaseGaugeUnavailable')}
            </p>
          ) : gaugeNoLimit ? (
            <div className="flex flex-col gap-2">
              <div className="h-2.5 w-full rounded-full border border-dashed border-border" />
              <p role="status" className="text-xs text-muted-foreground">
                {t('landing.showcaseGaugeNoLimit')}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-2 pt-1">
                <MoneyValue cents={usedCents} size="display" className="tabular-nums" />
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t('landing.showcaseColUsed')}: {formatCentsBRL(usedCents, locale)} /{' '}
                  {formatCentsBRL(limitCents, locale)}
                </span>
              </div>
              <div
                role="progressbar"
                data-band={band}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={clamped}
                aria-valuetext={gaugeText}
                aria-label={t('landing.showcaseBudgetsTitle')}
                className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  data-testid="bento-gauge-fill"
                  style={{ width: `${clamped}%` }}
                  className={cn(
                    'h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none',
                    BAND_FILL[band ?? 'ok'],
                  )}
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-semibold tabular-nums text-foreground">{percent}%</span>
                <span className="tabular-nums">{t(BAND_LABEL_KEY[band ?? 'ok'])}</span>
              </div>
              <p className="text-xs text-muted-foreground">{t('landing.bentoGaugeNote')}</p>
            </>
          )}
        </div>
      </li>
      {FEATURES.map((feature) => (
        <li key={feature.titleKey} className="lg:col-span-4">
          <FeatureCard
            icon={feature.icon}
            titleKey={feature.titleKey}
            descKey={feature.descKey}
            badgeKey={'badgeKey' in feature ? feature.badgeKey : undefined}
            badgeTestId={'badgeTestId' in feature ? feature.badgeTestId : undefined}
          />
        </li>
      ))}
    </ul>
  )
}
