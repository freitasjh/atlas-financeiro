import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { BillingMode } from '../model/catalog'

interface PlanToggleProps {
  mode: BillingMode
  onChange: (mode: BillingMode) => void
}

// Template PricingCard+Toggle (parte toggle): grupo mensal/anual,
// aria-pressed por botão, min-h-11 (44px), sem fetch/sessão, sem float.
export function PlanToggle({ mode, onChange }: PlanToggleProps) {
  const { t } = useTranslation()
  const options: Array<{ value: BillingMode; labelKey: string }> = [
    { value: 'monthly', labelKey: 'landing.billingMonthly' },
    { value: 'annual', labelKey: 'landing.billingAnnual' },
  ]
  return (
    <div
      role="group"
      aria-label={t('landing.billingToggleLabel')}
      className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-muted/40 p-1.5 shadow-2xs backdrop-blur-md"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={mode === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'inline-flex min-h-11 items-center rounded-full px-5 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            mode === opt.value
              ? 'bg-background text-foreground shadow-xs'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          {t(opt.labelKey)}
        </button>
      ))}
    </div>
  )
}
