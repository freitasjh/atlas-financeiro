import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface FeatureCardProps {
  icon: LucideIcon
  titleKey: string
  descKey: string
  badgeKey?: string
  badgeTestId?: string
}

// Template FeatureCard: ícone lucide + título/descrição via t(),
// selo opcional "Em breve" como span (sem CTA/link). Bento-style elevado.
export function FeatureCard({ icon: Icon, titleKey, descKey, badgeKey, badgeTestId }: FeatureCardProps) {
  const { t } = useTranslation()
  return (
    <div className="group relative flex flex-col justify-between gap-4 rounded-2xl border border-border/80 bg-card p-6 shadow-2xs transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-md">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-border/60 bg-primary/10 text-primary shadow-2xs transition-all duration-300 group-hover:-translate-y-0.5 group-hover:bg-primary group-hover:text-primary-foreground">
            <Icon className="h-6 w-6" aria-hidden="true" />
          </span>
          {badgeKey ? (
            <span
              data-testid={badgeTestId}
              className="inline-flex w-fit items-center rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground"
            >
              {t(badgeKey)}
            </span>
          ) : null}
        </div>
        <h3 className="text-lg font-bold tracking-tight text-foreground">{t(titleKey)}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">{t(descKey)}</p>
      </div>
    </div>
  )
}
