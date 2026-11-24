import { cva } from 'class-variance-authority'
import i18n from '@/i18n'
import { formatCentsBRL, cn } from '@/lib/utils'

// DS-01 (DESIGN-SYSTEM §2) — único formatador de dinheiro do produto.
// Centavos inteiros entram, string BRL sai; nenhum consumidor usa Intl para
// dinheiro. `tabular-nums` faz parte do template, nunca do consumidor.

const moneyVariants = cva('tabular-nums', {
  variants: {
    size: {
      sm: 'text-sm',
      md: 'text-sm sm:text-base font-semibold',
      display: 'text-3xl font-extrabold tracking-tight',
    },
    tone: {
      default: 'text-slate-900',
      positive: 'text-emerald-600',
      negative: 'text-rose-600',
      muted: 'text-slate-500',
    },
  },
  defaultVariants: { size: 'md', tone: 'default' },
})

export interface MoneyValueProps {
  cents: number
  size?: 'sm' | 'md' | 'display'
  tone?: 'default' | 'positive' | 'negative' | 'muted'
  signed?: boolean
  locale?: string
  as?: 'span' | 'div' | 'p'
  ariaLabel?: string
  className?: string
}

export function MoneyValue({
  cents,
  size,
  tone,
  signed = false,
  locale,
  as,
  ariaLabel,
  className,
}: MoneyValueProps) {
  const Component = as ?? 'span'
  // Locale de apresentação vem do i18n quando o consumidor não fixa um.
  const resolvedLocale = locale ?? i18n.language ?? 'pt-BR'
  const formatted = formatCentsBRL(cents, resolvedLocale)
  const text = signed && cents > 0 ? `+${formatted}` : formatted

  return (
    <Component className={cn(moneyVariants({ size, tone }), className)} aria-label={ariaLabel}>
      {text}
    </Component>
  )
}
