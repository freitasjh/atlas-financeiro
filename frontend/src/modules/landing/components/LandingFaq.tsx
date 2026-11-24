import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

const FAQ_ITEMS = [
  { qKey: 'landing.faqQ1', aKey: 'landing.faqA1' },
  { qKey: 'landing.faqQ2', aKey: 'landing.faqA2' },
  { qKey: 'landing.faqQ3', aKey: 'landing.faqA3' },
  { qKey: 'landing.faqQ4', aKey: 'landing.faqA4' },
] as const

// Template FaqAccordion: sanfona local, sem fetch/sessão, sem CTA,
// botões min-h-11 (44px), resposta em região acessível, foco semântico.
export function LandingFaq() {
  const { t } = useTranslation()
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  return (
    <div className="flex flex-col gap-3">
      {FAQ_ITEMS.map((item, index) => {
        const open = openIndex === index
        return (
          <div
            key={item.qKey}
            className="rounded-2xl border border-border/80 bg-card shadow-2xs transition-all hover:border-border"
          >
            <h3>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`landing-faq-panel-${index}`}
                onClick={() => setOpenIndex(open ? null : index)}
                className="flex min-h-12 w-full items-center justify-between gap-4 rounded-2xl px-5 py-4 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>{t(item.qKey)}</span>
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition-transform duration-200',
                    open && 'rotate-180 bg-primary/10 text-primary',
                  )}
                  aria-hidden="true"
                >
                  <ChevronDown className="h-4 w-4" />
                </span>
              </button>
            </h3>
            {open ? (
              <div
                id={`landing-faq-panel-${index}`}
                role="region"
                className="border-t border-border/60 px-5 pt-3 pb-5 text-sm leading-relaxed text-muted-foreground"
              >
                {t(item.aKey)}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
