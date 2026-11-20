import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StateBlock } from '@/components/ui/StateBlock'
import { MoneyValue } from '@/components/ui/money-value'
import { formatCentsBRL, cn } from '@/lib/utils'
import { limitBand, limitBps, usedPercent } from '@/lib/limit-band'

export interface ShowcaseStatement {
  id: string
  descriptionKey?: string
  description?: string
  date: string
  amountCents: number
  kind: 'income' | 'expense'
}

export interface ShowcaseBudget {
  id: string
  nameKey?: string
  name?: string
  limitCents: number
  usedCents: number
}

export interface ShowcaseRule {
  id: string
  keywordKey?: string
  keyword?: string
  targetKey?: string
  target?: string
}

export interface ShowcaseTabsProps {
  usedCents?: number
  limitCents?: number
  statements?: ShowcaseStatement[]
  budgets?: ShowcaseBudget[]
  rules?: ShowcaseRule[]
}

const DEFAULT_STATEMENTS: ShowcaseStatement[] = [
  { id: 'showcase-s1', descriptionKey: 'landing.demoMockDesc1', date: '2026-10-05', amountCents: 12590, kind: 'expense' },
  { id: 'showcase-s2', descriptionKey: 'landing.demoMockDesc2', date: '2026-10-10', amountCents: 4990, kind: 'expense' },
  { id: 'showcase-s3', descriptionKey: 'landing.demoMockDesc3', date: '2026-10-01', amountCents: 450000, kind: 'income' },
]

const DEFAULT_BUDGETS: ShowcaseBudget[] = [
  { id: 'showcase-b1', nameKey: 'landing.demoMockDesc1', limitCents: 80000, usedCents: 45230 },
  { id: 'showcase-b2', nameKey: 'landing.demoMockDesc2', limitCents: 20000, usedCents: 18450 },
]

const DEFAULT_RULES: ShowcaseRule[] = [
  { id: 'showcase-r1', keywordKey: 'landing.showcaseRuleKeywordMarket', targetKey: 'landing.demoMockDesc1' },
  { id: 'showcase-r2', keywordKey: 'landing.showcaseRuleKeywordSalary', targetKey: 'landing.demoMockDesc3' },
]

const TABS = [
  { value: 'invoices', labelKey: 'landing.showcaseInvoicesTab' },
  { value: 'statement', labelKey: 'landing.showcaseStatementTab' },
  { value: 'budgets', labelKey: 'landing.showcaseBudgetsTab' },
  { value: 'rules', labelKey: 'landing.showcaseRulesTab' },
] as const

type ShowcaseTab = (typeof TABS)[number]['value']

const BAND_FILL: Record<string, string> = {
  ok: 'bg-emerald-500',
  warning: 'bg-[var(--color-amber-500)]',
  critical: 'bg-rose-500',
  over: 'bg-rose-600',
}

const BAND_LABEL_KEY: Record<string, string> = {
  ok: 'landing.showcaseGaugeBandOk',
  warning: 'landing.showcaseGaugeBandWarning',
  critical: 'landing.showcaseGaugeBandCritical',
  over: 'landing.showcaseGaugeBandOver',
}

function isValidCents(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

// FE-01 — tabs financeiras em moldura macOS: Faturas (gauge RF03 60/85),
// Extrato, Orçamentos e Regras. Filtro local, selo DEMO, aria-live polite.
// Sem fetch/sessão; dinheiro só BIGINT cents; âmbar só via token var.
//
// Boundary landing→cards (exceção documentada): importa apenas os puros
// `limitBand`/`limitBps`/`usedPercent` de `@/lib/limit-band`
// (funções sem componente/store/efeito). Exceção aceita — mover para shared
// arrastaria refactor fora deste batch; reavaliar se o módulo cards mudar.
//
// TODO-FE-07: `LandingDemoMock` segue órfão até FE-07 compor a LandingPage
// (7 seções + band + footer). Não remover neste batch.
export function ShowcaseTabs({
  usedCents = 340000,
  limitCents = 500000,
  statements = DEFAULT_STATEMENTS,
  budgets = DEFAULT_BUDGETS,
  rules = DEFAULT_RULES,
}: ShowcaseTabsProps) {
  const { t, i18n } = useTranslation()
  const [active, setActive] = useState<ShowcaseTab>('invoices')
  const baseId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const locale = i18n.language ?? 'pt-BR'

  function focusTab(index: number): void {
    const count = TABS.length
    const next = (index + count) % count
    setActive(TABS[next].value)
    tabRefs.current[next]?.focus()
  }

  function onTablistKeyDown(event: React.KeyboardEvent): void {
    const current = TABS.findIndex((tab) => tab.value === active)
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusTab(current + 1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusTab(current - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusTab(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusTab(TABS.length - 1)
    }
  }

  const gaugeValid = isValidCents(usedCents) && isValidCents(limitCents)
  const gaugeNoLimit = gaugeValid && limitCents === 0
  const gaugeReady = gaugeValid && limitCents > 0
  const bps = gaugeReady ? limitBps(usedCents, limitCents) : null
  const band = gaugeReady ? limitBand(usedCents, limitCents) : null
  const percent = bps === null ? 0 : Math.round(usedPercent(bps))
  const clamped = Math.min(100, Math.max(0, percent))
  const available = gaugeReady ? Math.max(limitCents - usedCents, 0) : 0
  const overCents = gaugeReady ? Math.max(usedCents - limitCents, 0) : 0
  const gaugeText = gaugeReady
    ? t('landing.showcaseGaugeAria', {
        used: formatCentsBRL(usedCents, locale),
        available: formatCentsBRL(available, locale),
        total: formatCentsBRL(limitCents, locale),
        percent,
        band: t(BAND_LABEL_KEY[band ?? 'ok']),
        interpolation: { escapeValue: false },
      })
    : ''

  const counts: Record<ShowcaseTab, number> = {
    invoices: 1,
    statement: statements.length,
    budgets: budgets.length,
    rules: rules.length,
  }

  function countLabel(tab: ShowcaseTab): string {
    if (tab === 'invoices') return t('landing.showcaseGaugeTitle')
    return t('landing.showcaseCount', { count: counts[tab] })
  }

  function labelFor(tab: ShowcaseTab): string {
    const entry = TABS.find((item) => item.value === tab)
    return entry ? t(entry.labelKey) : ''
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-xl backdrop-blur-xl text-card-foreground">
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
          <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-[11px] font-bold tracking-widest text-foreground/90 shadow-2xs">
            {t('landing.showcaseDemoBadge')}
          </span>
        </div>

        <div className="border-b border-border/60 bg-card px-4 py-2.5">
          <div className="relative">
            <div
              role="tablist"
              aria-label={t('landing.showcaseTabsLabel')}
              onKeyDown={onTablistKeyDown}
              className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 py-0.5"
            >
              {TABS.map((tab, index) => {
                const selected = active === tab.value
                return (
                  <button
                    key={tab.value}
                    ref={(node) => {
                      tabRefs.current[index] = node
                    }}
                    type="button"
                    role="tab"
                    id={`${baseId}-tab-${tab.value}`}
                    aria-selected={selected}
                    aria-controls={`${baseId}-panel-${tab.value}`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setActive(tab.value)}
                    className={cn(
                      'inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-xs font-semibold transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-1',
                      selected
                        ? 'bg-primary text-primary-foreground shadow-xs'
                        : 'bg-muted text-foreground/90 hover:bg-muted/70 hover:text-foreground',
                    )}
                  >
                    {t(tab.labelKey)}
                  </button>
                )
              })}
            </div>
            {/* Faixa estreita: a 4ª pílula passa da borda — o degradê avisa que há
                mais conteúdo para rolar. Desktop/escondido acima de 420px. */}
            <div
              data-testid="showcase-tabs-fade"
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 hidden w-8 bg-gradient-to-l from-card to-transparent max-[420px]:block"
            />
          </div>
        </div>

        <div
          role="tabpanel"
          id={`${baseId}-panel-${active}`}
          aria-labelledby={`${baseId}-tab-${active}`}
          className="p-4 sm:p-5"
        >
          <p aria-live="polite" className="pb-3 text-xs font-medium text-muted-foreground tabular-nums">
            {labelFor(active)} · {countLabel(active)}
          </p>

          {active === 'invoices' ? (
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-foreground">{t('landing.showcaseGaugeTitle')}</h3>
              {!gaugeValid ? (
                <p role="status" className="text-xs font-medium text-destructive">
                  {t('landing.showcaseGaugeUnavailable')}
                </p>
              ) : gaugeNoLimit ? (
                <div className="flex flex-col gap-2">
                  <div className="h-2.5 w-full rounded-full border border-dashed border-border" />
                  <p role="status" className="text-xs text-muted-foreground">{t('landing.showcaseGaugeNoLimit')}</p>
                </div>
              ) : (
                <>
                  <dl className="grid grid-cols-3 gap-2 text-xs">
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-muted-foreground">{t('landing.showcaseGaugeUsed')}</dt>
                      <dd>
                        <MoneyValue cents={usedCents} size="sm" className="text-foreground" />
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-muted-foreground">{t('landing.showcaseGaugeAvailable')}</dt>
                      <dd>
                        <MoneyValue
                          cents={available}
                          size="sm"
                          tone={overCents > 0 ? 'negative' : 'default'}
                          className={
                            overCents > 0 ? 'text-rose-700 dark:text-rose-400' : 'text-foreground'
                          }
                        />
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-muted-foreground">{t('landing.showcaseGaugeTotal')}</dt>
                      <dd>
                        <MoneyValue cents={limitCents} size="sm" className="text-foreground" />
                      </dd>
                    </div>
                  </dl>
                  <div
                    role="progressbar"
                    data-band={band}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={clamped}
                    aria-valuetext={gaugeText}
                    aria-label={t('landing.showcaseGaugeTitle')}
                    className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      data-testid="showcase-gauge-fill"
                      style={{ width: `${clamped}%` }}
                      className={cn(
                        'h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none',
                        BAND_FILL[band ?? 'ok'],
                      )}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="font-semibold tabular-nums text-foreground">{percent}%</span>
                    <span className="tabular-nums">{t(BAND_LABEL_KEY[band ?? 'ok'])}</span>
                  </div>
                  {overCents > 0 ? (
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">{t('landing.showcaseGaugeOverBy')}</span>
                      <MoneyValue
                        cents={overCents}
                        size="sm"
                        tone="negative"
                        className="text-rose-700 dark:text-rose-400"
                      />
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {active === 'statement' ? (
            statements.length === 0 ? (
              <StateBlock state="empty">
                <p className="text-xs text-muted-foreground">{t('landing.showcaseEmptyHint')}</p>
              </StateBlock>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border/80">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 bg-muted/40 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <th scope="col" className="px-4 py-3">
                        {t('landing.showcaseColDescription')}
                      </th>
                      <th scope="col" className="px-4 py-3 text-right">
                        {t('landing.showcaseColValue')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50 bg-card">
                    {statements.map((row) => (
                      <tr key={row.id} className="transition-colors motion-reduce:transition-none hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium text-foreground">
                          <div className="flex items-center gap-2.5">
                            <span
                              className={cn(
                                'inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold',
                                row.kind === 'income' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground',
                              )}
                              aria-hidden="true"
                            >
                              {row.kind === 'income' ? '+' : '−'}
                            </span>
                            <span>{row.descriptionKey ? t(row.descriptionKey) : (row.description ?? '')}</span>
                          </div>
                          <span className="pl-8 text-xs font-normal text-muted-foreground tabular-nums">{row.date}</span>
                        </td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">
                          <span className={row.kind === 'income' ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground'}>
                            {row.kind === 'income' ? '+ ' : '− '}
                            {formatCentsBRL(row.amountCents, locale)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : null}

          {active === 'budgets' ? (
            budgets.length === 0 ? (
              <StateBlock state="empty">
                <p className="text-xs text-muted-foreground">{t('landing.showcaseEmptyHint')}</p>
              </StateBlock>
            ) : (
              <ul className="flex flex-col gap-3">
                {budgets.map((budget) => {
                  const budgetValid = isValidCents(budget.usedCents) && isValidCents(budget.limitCents)
                  const budgetNoLimit = budgetValid && budget.limitCents <= 0
                  const budgetBps = budgetValid && !budgetNoLimit ? limitBps(budget.usedCents, budget.limitCents) : null
                  const budgetBand = budgetValid && !budgetNoLimit ? limitBand(budget.usedCents, budget.limitCents) : null
                  const budgetPercent = budgetBps === null ? 0 : Math.round(usedPercent(budgetBps))
                  const budgetClamped = Math.min(100, Math.max(0, budgetPercent))
                  const budgetOver = budgetValid && !budgetNoLimit ? Math.max(budget.usedCents - budget.limitCents, 0) : 0
                  return (
                    <li
                      key={budget.id}
                      className="flex flex-col gap-1.5 rounded-xl border border-border/80 bg-background p-3.5 text-foreground"
                    >
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="font-medium text-foreground">
                          {budget.nameKey ? t(budget.nameKey) : (budget.name ?? '')}
                        </span>
                        {budgetValid && !budgetNoLimit ? (
                          <span className="text-xs text-muted-foreground tabular-nums">
                            <MoneyValue cents={budget.usedCents} size="sm" className="text-foreground" /> · {budgetPercent}%
                          </span>
                        ) : null}
                      </div>
                      {!budgetValid ? (
                        <p role="status" className="text-xs font-medium text-destructive">
                          {t('landing.showcaseGaugeUnavailable')}
                        </p>
                      ) : budgetNoLimit ? (
                        <div className="flex flex-col gap-2">
                          <div className="h-1.5 w-full rounded-full border border-dashed border-border" />
                          <p role="status" className="text-xs text-muted-foreground">{t('landing.showcaseGaugeNoLimit')}</p>
                        </div>
                      ) : (
                        <>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              data-testid="showcase-budget-fill"
                              data-band={budgetBand}
                              style={{ width: `${budgetClamped}%` }}
                              className={cn(
                                'h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none',
                                BAND_FILL[budgetBand ?? 'ok'],
                              )}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {t('landing.showcaseColUsed')}: {formatCentsBRL(budget.usedCents, locale)} /{' '}
                            {formatCentsBRL(budget.limitCents, locale)}
                          </span>
                          {budgetOver > 0 ? (
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="text-muted-foreground">{t('landing.showcaseGaugeOverBy')}</span>
                              <MoneyValue
                                cents={budgetOver}
                                size="sm"
                                tone="negative"
                                className="text-rose-700 dark:text-rose-400"
                              />
                            </div>
                          ) : null}
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
            )
          ) : null}

          {active === 'rules' ? (
            rules.length === 0 ? (
              <StateBlock state="empty">
                <p className="text-xs text-muted-foreground">{t('landing.showcaseEmptyHint')}</p>
              </StateBlock>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {rules.map((rule) => (
                  <li
                    key={rule.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-background px-3.5 py-3 text-sm text-foreground"
                  >
                    <span className="rounded-full bg-muted px-2.5 py-1 font-mono text-xs font-semibold text-foreground">
                      {rule.keywordKey ? t(rule.keywordKey) : (rule.keyword ?? '')}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t('landing.showcaseColMatch')}:{' '}
                      <span className="font-medium text-foreground">
                        {rule.targetKey ? t(rule.targetKey) : (rule.target ?? '')}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      </div>
    </div>
  )
}
