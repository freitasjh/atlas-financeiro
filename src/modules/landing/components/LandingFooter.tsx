import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'

const PRODUCT_LINKS = [
  { href: '#hero', labelKey: 'landing.navHero' },
  { href: '#demo', labelKey: 'landing.navDemo' },
  { href: '#planos', labelKey: 'landing.navPlans' },
  { href: '#faq', labelKey: 'landing.navFaq' },
] as const

const FEATURE_LINKS = [
  { href: '#recursos', labelKey: 'landing.navFeatures' },
  { href: '#como-funciona', labelKey: 'landing.navSteps' },
  { href: '#prova', labelKey: 'landing.navProof' },
] as const

const TERMS = ['landing.termsItem1', 'landing.termsItem2', 'landing.termsItem3'] as const

const LINK_CLASS =
  'inline-flex min-h-11 items-center rounded-lg px-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600'

const CURRENT_YEAR = new Date().getFullYear()

// FE-05 — rodapé 4col (Produto/Recursos/Comparar/Legal) + terms 1-3 +
// footerNote + bottom bar ano. Sem section/id novo, sem CTA extra, sem
// fetch/sessão; links com alvo 44px e foco visível; ano tabular-nums.
//
// @deprecated Sem importador em `src/` desde a landing v2 (o footer vive em
// `pages/LandingPage.tsx`). Mantido apenas pela cobertura dedicada de i18n em
// `__tests__/landing-footer.spec.tsx`. Não contém CTA; não reintroduzir
// o testid `landing-cta` aqui.
export function LandingFooter() {
  const { t } = useTranslation()
  return (
    <footer data-testid="landing-footer" className="border-t border-border/60 bg-background/50 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-xs font-mono">
            A
          </span>
          <div className="flex flex-col">
            <span className="text-base font-bold text-foreground">{t('shell.appName')}</span>
            <span className="text-xs text-muted-foreground">{t('landing.footerTagline')}</span>
          </div>
        </div>
        <nav aria-label={t('landing.footerColLegal')} data-testid="footer-cols" className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {t('landing.footerColProduct')}
            </h3>
            <ul className="flex flex-col">
              {PRODUCT_LINKS.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className={LINK_CLASS}>
                    {t(link.labelKey)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {t('landing.footerColFeatures')}
            </h3>
            <ul className="flex flex-col">
              {FEATURE_LINKS.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className={LINK_CLASS}>
                    {t(link.labelKey)}
                  </a>
                </li>
              ))}
              <li>
                <Link to="/login" className={LINK_CLASS}>
                  {t('landing.heroLogin')}
                </Link>
              </li>
            </ul>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {t('landing.footerColCompare')}
            </h3>
            <ul className="flex flex-col">
              {(['landing.compareRow1', 'landing.compareRow2', 'landing.compareRow3', 'landing.compareRow4'] as const).map(
                (rowKey) => (
                  <li key={rowKey} className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
                    <Check className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
                    <span>{t(rowKey)}</span>
                  </li>
                ),
              )}
            </ul>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {t('landing.footerColLegal')}
            </h3>
            <ul className="flex flex-col gap-1">
              {TERMS.map((termKey) => (
                <li key={termKey} className="flex items-start gap-2 py-1 text-sm text-muted-foreground">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
                  <span>{t(termKey)}</span>
                </li>
              ))}
            </ul>
          </div>
        </nav>
        <div className="flex flex-col gap-2 border-t border-border/60 pt-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            {t('shell.appName')} · {t('landing.footerNote')}
          </p>
          <p className="tabular-nums">© {CURRENT_YEAR} {t('shell.appName')}.</p>
        </div>
      </div>
    </footer>
  )
}
