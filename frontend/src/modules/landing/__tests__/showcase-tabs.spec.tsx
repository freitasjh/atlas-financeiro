// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../../i18n'
import type { ReactNode } from 'react'

afterEach(() => cleanup())

function renderWithI18n(node: ReactNode) {
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </MemoryRouter>,
  )
}

// FE-01 TDD FIRST — ShowcaseTabs financeiras em moldura macOS.
// 4 tabs em pílula role=tablist; Faturas com gauge RF03; selo DEMO;
// aria-live polite count; tabular-nums; min-h-11; foco emerald;
// reduced-motion sem slide; StateBlock empty se vazio.
const SHOWCASE_KEYS = [
  'showcaseInvoicesTab',
  'showcaseStatementTab',
  'showcaseBudgetsTab',
  'showcaseRulesTab',
  'showcaseTabsLabel',
  'showcaseDemoBadge',
  'showcaseCount_one',
  'showcaseCount_other',
  'showcaseGaugeTitle',
  'showcaseGaugeUsed',
  'showcaseGaugeAvailable',
  'showcaseGaugeTotal',
  'showcaseGaugeAria',
  'showcaseGaugeBandOk',
  'showcaseGaugeBandWarning',
  'showcaseGaugeBandCritical',
  'showcaseGaugeBandOver',
  'showcaseGaugeOverBy',
  'showcaseGaugeNoLimit',
  'showcaseGaugeUnavailable',
  'showcaseStatementTitle',
  'showcaseBudgetsTitle',
  'showcaseRulesTitle',
  'showcaseColDescription',
  'showcaseColValue',
  'showcaseColUsed',
  'showcaseColMatch',
  'showcaseEmptyHint',
] as const

describe('whenShowcaseI18n_thenPtEnPairs', () => {
  it('todas as chaves showcase existem em pt-BR e en-US sem termo de cobrança', async () => {
    const { default: ptBR } = await import('../../../i18n/messages/pt-BR')
    const { default: enUS } = await import('../../../i18n/messages/en-US')
    for (const key of SHOWCASE_KEYS) {
      expect(ptBR.landing[key], `pt-BR landing.${key} ausente`).toBeTruthy()
      expect(enUS.landing[key], `en-US landing.${key} ausente`).toBeTruthy()
    }
    const all = SHOWCASE_KEYS.map((k) => `${ptBR.landing[k]} ${enUS.landing[k]}`.toLowerCase()).join(' ')
    for (const banned of ['assinar', 'checkout', 'pague agora']) {
      expect(all, `copy com promessa: ${banned}`).not.toContain(banned)
    }
    expect(all).not.toMatch(/pagar/)
  })
})

describe('whenShowcaseTabsRendered_thenTablistA11y', () => {
  it('4 tabs em pílula com tablist, aria-selected e troca de painel', async () => {
    const { ShowcaseTabs } = await import('../components/ShowcaseTabs')
    const { container } = renderWithI18n(<ShowcaseTabs />)
    const tablist = container.querySelector('[role="tablist"]')
    expect(tablist, 'tablist ausente').not.toBeNull()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(4)
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    for (const tab of tabs) {
      expect(tab.className).toMatch(/min-h-11/)
      expect(tab.className).toMatch(/focus-visible:ring-emerald-600/)
    }
    fireEvent.click(tabs[1])
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(tabs[0].getAttribute('aria-selected')).toBe('false')
    expect(container.querySelector('[role="tabpanel"]'), 'tabpanel ausente').not.toBeNull()
  })

  it('arrow-keys navegam entre tabs (Right/Left/Home/End)', async () => {
    const { ShowcaseTabs } = await import('../components/ShowcaseTabs')
    renderWithI18n(<ShowcaseTabs />)
    const tabs = screen.getAllByRole('tab')
    tabs[0].focus()
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' })
    expect(screen.getAllByRole('tab')[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' })
    expect(screen.getAllByRole('tab')[3].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' })
    expect(screen.getAllByRole('tab')[0].getAttribute('aria-selected')).toBe('true')
  })

  it('selo DEMO visível e contagem com aria-live polite + tabular-nums', async () => {
    const { ShowcaseTabs } = await import('../components/ShowcaseTabs')
    const { container } = renderWithI18n(<ShowcaseTabs />)
    expect(screen.getByText('DEMO')).toBeTruthy()
    const live = container.querySelector('[aria-live="polite"]')
    expect(live, 'aria-live polite ausente').not.toBeNull()
    expect(live?.className ?? '').toMatch(/tabular-nums/)
  })
})

describe('whenShowcaseGaugeRendered_thenRf03Bands', () => {
  it('faixa ok (<60%) usa emerald com progressbar e aria-valuetext completo', async () => {
    const { ShowcaseTabs } = await import('../components/ShowcaseTabs')
    renderWithI18n(<ShowcaseTabs usedCents={150000} limitCents={500000} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('30')
    const text = bar.getAttribute('aria-valuetext') ?? ''
    expect(text).toMatch(/30%/)
    expect(bar.querySelector('[data-testid="showcase-gauge-fill"]')?.className ?? '').toMatch(/bg-emerald-500/)
  })

  it('faixa warning (60–85%) usa var(--color-amber-500), nunca bg-amber-500', async () => {
    const { ShowcaseTabs } = await import('../components/ShowcaseTabs')
    const { container } = renderWithI18n(<ShowcaseTabs usedCents={340000} limitCents={500000} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('data-band')).toBe('warning')
    const fill = container.querySelector('[data-testid="showcase-gauge-fill"]')
    expect(fill?.className ?? '').toMatch(/bg-\[var\(--color-amber-500\)\]/)
    expect(container.innerHTML).not.toContain('bg-amber-500')
  })

  it('faixa critical (>85%) usa rose-500 e over usa rose-600', async () => {
    const { ShowcaseTabs } = await import('../components/ShowcaseTabs')
    const { container, unmount } = renderWithI18n(<ShowcaseTabs usedCents={460000} limitCents={500000} />)
    expect(screen.getByRole('progressbar').getAttribute('data-band')).toBe('critical')
    expect(container.querySelector('[data-testid="showcase-gauge-fill"]')?.className ?? '').toMatch(/bg-rose-500/)
    unmount()
    const over = renderWithI18n(<ShowcaseTabs usedCents={520000} limitCents={500000} />)
    expect(screen.getByRole('progressbar').getAttribute('data-band')).toBe('over')
    expect(over.container.querySelector('[data-testid="showcase-gauge-fill"]')?.className ?? '').toMatch(/bg-rose-600/)
  })

  it('sem limite e indisponível usam role=status sem renderizar 0%', async () => {
    const { ShowcaseTabs } = await import('../components/ShowcaseTabs')
    const { unmount } = renderWithI18n(<ShowcaseTabs usedCents={0} limitCents={0} />)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    unmount()
    renderWithI18n(<ShowcaseTabs usedCents={NaN} limitCents={500000} />)
    expect(screen.getByRole('status')).toBeTruthy()
  })
})

describe('whenShowcaseEmpty_thenStateBlock', () => {
  it('listas vazias rendem StateBlock empty sem quebrar tabs', async () => {
    const { ShowcaseTabs } = await import('../components/ShowcaseTabs')
    renderWithI18n(<ShowcaseTabs statements={[]} budgets={[]} rules={[]} />)
    const emptyLabel = i18n.t('common.empty')
    const hintLabel = i18n.t('landing.showcaseEmptyHint')
    const tabs = screen.getAllByRole('tab')
    fireEvent.click(tabs[1])
    expect(screen.getByText(emptyLabel)).toBeTruthy()
    expect(screen.getByText(hintLabel)).toBeTruthy()
    fireEvent.click(tabs[2])
    expect(screen.getByText(emptyLabel)).toBeTruthy()
    expect(screen.getByText(hintLabel)).toBeTruthy()
    fireEvent.click(tabs[3])
    expect(screen.getByText(emptyLabel)).toBeTruthy()
    expect(screen.getByText(hintLabel)).toBeTruthy()
  })
})

describe('whenShowcaseBudgetsEdge_thenNoNaN', () => {
  it('limite zero rende role=status com showcaseGaugeNoLimit sem NaN%', async () => {
    const { ShowcaseTabs } = await import('../components/ShowcaseTabs')
    const { container } = renderWithI18n(
      <ShowcaseTabs budgets={[{ id: 'b0', name: 'Zero', limitCents: 0, usedCents: 0 }]} />,
    )
    fireEvent.click(screen.getAllByRole('tab')[2])
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText(i18n.t('landing.showcaseGaugeNoLimit'))).toBeTruthy()
    expect(container.textContent ?? '').not.toMatch(/NaN/)
  })

  it('cents inválidos rendem showcaseGaugeUnavailable sem progressbar de orçamento', async () => {
    const { ShowcaseTabs } = await import('../components/ShowcaseTabs')
    const { container } = renderWithI18n(
      <ShowcaseTabs budgets={[{ id: 'bNaN', name: 'NaN', limitCents: 20000, usedCents: NaN }]} />,
    )
    fireEvent.click(screen.getAllByRole('tab')[2])
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText(i18n.t('landing.showcaseGaugeUnavailable'))).toBeTruthy()
    expect(container.querySelector('[data-testid="showcase-budget-fill"]')).toBeNull()
  })

  it('over (used>limit) usa bg-rose-600 com banda over; >85% usa bg-rose-500', async () => {
    const { ShowcaseTabs } = await import('../components/ShowcaseTabs')
    const { container, unmount } = renderWithI18n(
      <ShowcaseTabs budgets={[{ id: 'bCrit', name: 'Crit', limitCents: 20000, usedCents: 18450 }]} />,
    )
    fireEvent.click(screen.getAllByRole('tab')[2])
    const critBar = container.querySelector('[data-testid="showcase-budget-fill"]')
    expect(critBar?.getAttribute('data-band')).toBe('critical')
    expect(critBar?.className ?? '').toMatch(/bg-rose-500/)
    unmount()
    const over = renderWithI18n(
      <ShowcaseTabs budgets={[{ id: 'bOver', name: 'Over', limitCents: 20000, usedCents: 25000 }]} />,
    )
    fireEvent.click(screen.getAllByRole('tab')[2])
    const overBar = over.container.querySelector('[data-testid="showcase-budget-fill"]')
    expect(overBar?.getAttribute('data-band')).toBe('over')
    expect(overBar?.className ?? '').toMatch(/bg-rose-600/)
  })
})

describe("whenTabStripOverflows_thenScrollAffordanceIsExplicit", () => {
  it('faixa estreita ganha degradê na borda e hint acessível sem mudar o desktop', async () => {
    const { ShowcaseTabs } = await import('../components/ShowcaseTabs')
    const { container } = renderWithI18n(<ShowcaseTabs />)

    const tablist = screen.getByRole('tablist')
    const fade = container.querySelector('[data-testid="showcase-tabs-fade"]')
    expect(fade, 'indicador de scroll ausente').not.toBeNull()
    expect(fade?.getAttribute('aria-hidden')).toBe('true')
    expect(fade?.className ?? '').toMatch(/pointer-events-none/)
    expect(fade?.className ?? '').toMatch(/max-\[420px\]:block/)
    expect(fade?.className ?? '').toMatch(/bg-gradient-to-l/)

    // O rótulo do tablist já nomeia a região; o degradê é a affordance visual.
    expect(tablist.getAttribute('aria-label')).toBe(i18n.t('landing.showcaseTabsLabel'))
  })
})

describe('whenShowcaseSourceAudited_thenZeroFetchZeroAmber', () => {
  it('sem supabase/fetch/sessão/innerHTML e sem bg-amber-500 literal', () => {
    const content = readFileSync('frontend/src/modules/landing/components/ShowcaseTabs.tsx', 'utf8')
    expect(content).not.toMatch(/supabase/i)
    expect(content).not.toMatch(/useAuthStore|getSession|access_token/i)
    expect(content).not.toMatch(/fetch\(|axios|XMLHttpRequest/i)
    expect(content).not.toContain('dangerouslySetInnerHTML')
    expect(content).not.toContain('bg-amber-500')
    expect(content).toContain('role="tablist"')
    expect(content).toContain('tabular-nums')
    expect(content).toContain('motion-reduce')
  })
})
