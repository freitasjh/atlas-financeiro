import { useTranslation } from 'react-i18next'

const PILLS = [
  'landing.proofPill1',
  'landing.proofPill2',
  'landing.proofPill3',
  'landing.proofPill4',
] as const

const METRICS = [
  { valueKey: 'landing.heroStat1Value', labelKey: 'landing.heroStat1Label' },
  { valueKey: 'landing.heroStat2Value', labelKey: 'landing.heroStat2Label' },
  { valueKey: 'landing.heroStat3Value', labelKey: 'landing.heroStat3Label' },
] as const

// FE-02 — faixa de prova sem depoimentos (veto PM): pills de capacidades em
// texto + métricas atuais. Sem section/id (não cria âncora), sem CTA, sem
// blockquote/nomes, sem fetch/sessão; números sempre tabular-nums.
//
// @deprecated Sem importador em `src/` desde a landing v2 (a seção `#prova`
// vive em `pages/LandingPage.tsx`). Mantido apenas pela cobertura dedicada de
// i18n em `__tests__/proof-strip.spec.tsx`. Não contém CTA; não reintroduzir
// o testid `landing-cta` aqui.
export function ProofStrip() {
  const { t } = useTranslation()
  return (
    <div data-testid="proof-strip" className="flex flex-col gap-5">
      <ul aria-label={t('landing.navProof')} className="flex flex-wrap items-center gap-2">
        {PILLS.map((pillKey) => (
          <li key={pillKey}>
            <span className="inline-flex min-h-11 items-center rounded-full border border-border/80 bg-card px-4 text-xs font-semibold text-muted-foreground shadow-2xs">
              {t(pillKey)}
            </span>
          </li>
        ))}
      </ul>
      <dl className="grid w-full gap-3 sm:grid-cols-3">
        {METRICS.map((metric) => (
          <div
            key={metric.labelKey}
            className="flex flex-col gap-1 rounded-xl border border-border/70 bg-card p-4 shadow-2xs"
          >
            <dt className="order-2 text-xs text-muted-foreground">{t(metric.labelKey)}</dt>
            <dd className="order-1 text-xl font-bold tracking-tight text-foreground tabular-nums sm:text-2xl">
              {t(metric.valueKey)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
