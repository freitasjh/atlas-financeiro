import { useTranslation } from 'react-i18next'
import { Plus, Search } from 'lucide-react'
import { Button } from '@/components/shadcn/ui/button'
import { Input } from '@/components/shadcn/ui/input'
import { cn } from '@/lib/cn'
import type { CategoryTypeFilter } from '../hooks/useCategories'

// C2.2 — toolbar <search>: busca + pílulas + CTA único (Regra da Ação Única).
// O debounce (~150ms) vive na View; aqui o input é controlado puro.

interface CategoriesToolbarProps {
  query: string
  onQueryChange: (query: string) => void
  typeFilter: CategoryTypeFilter
  onTypeFilterChange: (filter: CategoryTypeFilter) => void
  onNew: () => void
  actions?: React.ReactNode
}

const PILLS: CategoryTypeFilter[] = ['all', 'income', 'expense']

export function CategoriesToolbar({
  query,
  onQueryChange,
  typeFilter,
  onTypeFilterChange,
  onNew,
  actions,
}: CategoriesToolbarProps) {
  const { t } = useTranslation()

  const pillLabel = (pill: CategoryTypeFilter): string =>
    pill === 'all' ? t('categories.all') : pill === 'income' ? t('categories.incomes') : t('categories.expenses')

  return (
    <search
      role="search"
      aria-label={t('categories.toolbarLabel')}
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={t('categories.searchLabel')}
            placeholder={t('categories.searchPlaceholder')}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>

        <div
          role="group"
          aria-label={t('categories.pillsLabel')}
          className="flex w-fit max-w-full shrink-0 items-center gap-0.5 overflow-x-auto rounded-lg border border-border/80 bg-muted/40 p-0.5 shadow-2xs"
        >
          {PILLS.map((pill) => {
            const active = typeFilter === pill
            return (
              <Button
                key={pill}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={active}
                onClick={() => onTypeFilterChange(pill)}
                className={cn(
                  'h-11 min-h-11 sm:h-7 sm:min-h-7 shrink-0 gap-1.5 px-2.5 text-xs font-semibold rounded-md transition-all',
                  active
                    ? 'bg-background text-foreground font-bold shadow-2xs ring-1 ring-border/50'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                {pillLabel(pill)}
              </Button>
            )
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {actions}
        {/* Desvio desktop documentado: h-8 denso igual ao "+ Nova Transação" da
            tabela de transações (toolbar densa); mobile mantém 44px via max-sm:min-h-11. */}
        <Button
          type="button"
          size="sm"
          onClick={onNew}
          className="h-8 gap-1.5 text-xs font-semibold max-sm:min-h-11 max-sm:w-full"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t('categories.new')}
        </Button>
      </div>
    </search>
  )
}
