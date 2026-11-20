import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StateBlock } from '@/components/ui/StateBlock'
import { formatCentsBRL, cn } from '@/lib/utils'

export interface LandingDemoRow {
  id: string
  description?: string
  descriptionKey?: string
  date: string
  amountCents: number
  kind: 'income' | 'expense'
}

const MOCK_ROWS: LandingDemoRow[] = [
  { id: 'mock-1', descriptionKey: 'landing.demoMockDesc1', date: '2026-10-05', amountCents: 12590, kind: 'expense' },
  { id: 'mock-2', descriptionKey: 'landing.demoMockDesc2', date: '2026-10-10', amountCents: 4990, kind: 'expense' },
  { id: 'mock-3', descriptionKey: 'landing.demoMockDesc3', date: '2026-10-01', amountCents: 450000, kind: 'income' },
]

const FILTERS = [
  { value: 'all', labelKey: 'landing.demoFilterAll' },
  { value: 'income', labelKey: 'landing.demoFilterIncome' },
  { value: 'expense', labelKey: 'landing.demoFilterExpense' },
] as const

type DemoFilter = (typeof FILTERS)[number]['value']

interface LandingDemoMockProps {
  rows?: LandingDemoRow[]
}

// Template HeroMockup + demo interativa mock: moldura de janela macOS,
// filtro local por tipo, sem fetch/sessão. Selo de demonstração visível;
// botões min-h-11 (44px). Edge sem linhas -> StateBlock empty. Valores tabular-nums.
export function LandingDemoMock({ rows = MOCK_ROWS }: LandingDemoMockProps) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<DemoFilter>('all')

  if (rows.length === 0) {
    return <StateBlock state="empty" />
  }

  const visible = filter === 'all' ? rows : rows.filter((row) => row.kind === filter)

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-2xl border border-border/80 bg-card text-card-foreground shadow-xl backdrop-blur-xl">
        {/* Barra superior estilo macOS */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5" aria-hidden="true">
              <span className="h-3 w-3 rounded-full bg-rose-400" />
              <span className="h-3 w-3 rounded-full bg-amber-400" />
              <span className="h-3 w-3 rounded-full bg-emerald-400" />
            </div>
            <span className="ml-2 text-xs font-medium text-muted-foreground">
              {t('shell.appName')} · {t('landing.demoTitle')}
            </span>
          </div>
          <span className="rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground shadow-2xs">
            {t('landing.demoBadge')}
          </span>
        </div>

        {/* Barra de ferramentas com filtros interativos */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-card px-4 py-2.5">
          <div className="flex items-center gap-1" role="group" aria-label={t('landing.demoTitle')}>
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'inline-flex min-h-11 items-center rounded-lg px-3.5 text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  filter === f.value
                    ? 'bg-primary text-primary-foreground shadow-xs'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {t(f.labelKey)}
              </button>
            ))}
          </div>
          <span className="hidden sm:inline-flex text-xs font-medium text-muted-foreground">
            {t('landing.colAtlas')}
          </span>
        </div>

        {/* Tabela de dados ou StateBlock vazio */}
        {visible.length === 0 ? (
          <div className="p-6">
            <StateBlock state="empty" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/30 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="px-5 py-3.5">{t('landing.demoDescription')}</th>
                  <th scope="col" className="px-5 py-3.5">{t('landing.demoDate')}</th>
                  <th scope="col" className="px-5 py-3.5 text-right">{t('landing.demoValue')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50 bg-card">
                {visible.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-muted/40">
                    <td className="px-5 py-3.5 font-medium text-foreground">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={cn(
                            'inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold',
                            row.kind === 'income'
                              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                              : 'bg-muted text-muted-foreground',
                          )}
                          aria-hidden="true"
                        >
                          {row.kind === 'income' ? '+' : '−'}
                        </span>
                        <span>{row.descriptionKey ? t(row.descriptionKey) : (row.description ?? '')}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-xs text-muted-foreground">{row.date}</td>
                    <td className="px-5 py-3.5 text-right font-semibold tabular-nums">
                      <span className={row.kind === 'income' ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground'}>
                        {row.kind === 'income' ? '+ ' : '− '}
                        {formatCentsBRL(row.amountCents)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

