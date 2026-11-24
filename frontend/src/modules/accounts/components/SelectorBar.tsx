import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Plus, Star, Landmark, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/shadcn/ui/button'
import { cn } from '@/lib/cn'
import { formatCentsBRL } from '@/lib/utils'
import { institutionInfo, type AccountViewItem } from '../model/view-model'

interface SelectorBarProps {
  accounts: AccountViewItem[]
  selectedAccountId: string
  totalConsolidatedBalanceCents: number
  onSelectAccount: (accountId: string) => void
  onAddNewAccount: () => void
  className?: string
}

const CHIP_CLASS = cn(
  'flex min-h-11 shrink-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-left',
  'transition-all cursor-pointer shadow-2xs',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
)

export function SelectorBar({
  accounts,
  selectedAccountId,
  totalConsolidatedBalanceCents,
  onSelectAccount,
  onAddNewAccount,
  className,
}: SelectorBarProps) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const isConsolidatedSelected = selectedAccountId === ''

  const scrollCarousel = (direction: 'left' | 'right') => {
    scrollRef.current?.scrollBy({ left: direction === 'left' ? -300 : 300, behavior: 'smooth' })
  }

  return (
    <div className={cn('relative flex min-w-0 w-full max-w-full items-center gap-2', className)}>
      {/* Ação de criação no início: sempre visível, nunca dentro do trilho (B-A4) */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAddNewAccount}
        className="min-h-11 h-11 shrink-0 gap-1.5 rounded-xl border-dashed border-border/90 text-xs font-semibold"
      >
        <Plus className="h-3.5 w-3.5" />
        <span>{t('accounts.selector.newAccount')}</span>
      </Button>

      {/* Divisor sutil (B-A3) */}
      <div
        data-testid="accounts-chips-divider"
        aria-hidden="true"
        className="hidden h-8 w-px shrink-0 bg-border/70 sm:block"
      />

      {/* Chip consolidado fixo, com estado exposto (B-A2) */}
      <button
        type="button"
        onClick={() => onSelectAccount('')}
        aria-pressed={isConsolidatedSelected}
        className={cn(
          CHIP_CLASS,
          isConsolidatedSelected
            ? 'border-primary bg-primary/10 ring-1 ring-primary/20'
            : 'border-border/80 bg-card hover:bg-muted/50 hover:border-border',
        )}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary shrink-0">
          <Landmark className="h-4 w-4" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-bold text-foreground">{t('accounts.selector.consolidated')}</span>
          <span className="font-mono text-xs font-bold text-foreground tabular-nums">
            {formatCentsBRL(totalConsolidatedBalanceCents)}
          </span>
        </div>
      </button>

      {/* Rolagem do carrossel — esquerda (B-A3) */}
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => scrollCarousel('left')}
        aria-label={t('accounts.selector.scrollLeft')}
        title={t('accounts.selector.scrollLeft')}
        className="hidden min-h-11 min-w-11 shrink-0 rounded-lg border-border/80 text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex sm:min-h-8 sm:min-w-8"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      {/* Trilho rolável: apenas contas (B-A4) */}
      <div
        data-testid="accounts-chips"
        ref={scrollRef}
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        className="flex min-w-0 w-full max-w-full flex-1 flex-nowrap items-center gap-2 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {accounts.map((account) => {
          const isSelected = account.id === selectedAccountId
          const inst = institutionInfo(account.institution)

          return (
            <button
              key={account.id}
              type="button"
              onClick={() => onSelectAccount(account.id)}
              aria-pressed={isSelected}
              className={cn(
                CHIP_CLASS,
                isSelected
                  ? 'border-primary bg-primary/10 ring-1 ring-primary/20'
                  : 'border-border/80 bg-card hover:bg-muted/50 hover:border-border',
              )}
            >
              <div
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-bold text-[10px] border shadow-2xs',
                  inst.lightBg,
                )}
              >
                {inst.iconInitials}
              </div>

              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-foreground truncate max-w-[130px]">{account.nickname}</span>
                  {account.isDefault && (
                    <span title={t('accounts.card.default')}>
                      <Star className="h-3 w-3 fill-amber-500 text-amber-500 shrink-0" />
                    </span>
                  )}
                  {account.connectionStatus === 'connected' && (
                    <span title={t('accounts.connectionBadge.connected')}>
                      <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                    </span>
                  )}
                </div>
                <span className="font-mono text-xs font-bold text-foreground tabular-nums">
                  {formatCentsBRL(account.currentBalanceCents)}
                </span>
              </div>
            </button>
          )
        })}
      </div>

      {/* Rolagem do carrossel — direita (B-A3) */}
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => scrollCarousel('right')}
        aria-label={t('accounts.selector.scrollRight')}
        title={t('accounts.selector.scrollRight')}
        className="hidden min-h-11 min-w-11 shrink-0 rounded-lg border-border/80 text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex sm:min-h-8 sm:min-w-8"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  )
}
