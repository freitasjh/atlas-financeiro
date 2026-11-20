import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { planCtaHref } from '../model/catalog'

/**
 * @deprecated Sem importador em `src/` desde a landing v2 (o CTA final vive em
 * `pages/LandingPage.tsx`). Mantido apenas pela cobertura dedicada de i18n em
 * `__tests__/final-cta-band.spec.tsx`. Não religar sem revisar: o CTA não usa
 * mais o testid `landing-cta` (a contagem canônica é 5) e todas as
 * superfícies usam tokens semânticos.
 */
export function FinalCtaBand() {
  const { t } = useTranslation()
  return (
    <div
      data-testid="final-cta-band"
      role="region"
      aria-label={t('landing.finalCtaTitle')}
      className="relative overflow-hidden rounded-2xl border border-border/80 bg-card px-6 py-10 text-center shadow-xl sm:px-10 sm:py-12 dark:border-border/60"
    >
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-primary/20 via-primary/5 to-transparent"
        aria-hidden="true"
      />
      <div className="relative flex flex-col items-center gap-4">
        <h2 className="max-w-xl text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
          {t('landing.finalCtaTitle')}
        </h2>
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          {t('landing.finalCtaSubtitle')}
        </p>
        <Link
          to={planCtaHref('free')}
          className="inline-flex min-h-12 h-12 items-center justify-center rounded-xl bg-primary hover:bg-primary/90 px-8 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:-translate-y-0.5 hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {t('landing.heroCta')}
        </Link>
      </div>
    </div>
  )
}
