import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/shadcn/ui/badge'

// ADR-005: identidade PCI-safe. last4 ausente é estado honesto (•••• + chip
// pendente); nenhum dígito é inferido de nickname/brand. Sem backfill.
// ADR-006: tone='art' usa branco translúcido para a arte escura do cartão;
// superfícies estruturais continuam em tokens semânticos (default 'surface').
export interface CardIdentityProps {
  last4: string | null | undefined
  tone?: 'surface' | 'art'
}

export function CardIdentity({ last4, tone = 'surface' }: CardIdentityProps) {
  const { t } = useTranslation()
  const isArt = tone === 'art'
  const hasLast4 = last4 != null && last4 !== ''
  const digitsClass = isArt
    ? 'font-mono text-xs font-semibold tabular-nums text-white/70'
    : 'font-mono text-xs font-semibold tabular-nums text-muted-foreground'
  const badgeClass = isArt
    ? 'border-white/20 bg-white/10 px-1.5 py-0 text-[10px] font-medium text-white'
    : 'border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'
  const filledClass = isArt
    ? 'inline-flex min-w-0 items-center font-mono text-xs font-semibold tabular-nums text-white'
    : 'inline-flex min-w-0 items-center font-mono text-xs font-semibold tabular-nums text-foreground'

  if (!hasLast4) {
    return (
      <span data-testid="card-identity" className="inline-flex min-w-0 items-center gap-1.5">
        <span className={digitsClass}>••••</span>
        <Badge data-testid="card-identity-pending" variant="outline" className={badgeClass}>
          {t('cards.identity.pending')}
        </Badge>
      </span>
    )
  }

  return (
    <span data-testid="card-identity" className={filledClass}>
      {`•${last4}`}
    </span>
  )
}
