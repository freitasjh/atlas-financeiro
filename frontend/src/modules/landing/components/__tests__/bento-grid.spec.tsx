// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../../../i18n'
import type { ReactNode } from 'react'

function renderWithI18n(node: ReactNode) {
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </MemoryRouter>,
  )
}

afterEach(() => cleanup())

// FE-03 TDD FIRST — BentoGrid 12col: tile-8 Orçamentos gauge + 4 FEATURES.
// Grid 1col mobile / 2col sm / 12col lg; spans 8 + 4/4/4/4; hover elevado.
describe('whenBentoI18n_thenPtEnPairs', () => {
  it('features + gauge keys existem nas duas locales sem cobrança', async () => {
    const { default: ptBR } = await import('../../../../i18n/messages/pt-BR')
    const { default: enUS } = await import('../../../../i18n/messages/en-US')
    for (const key of [
      'feature1Title',
      'feature1Desc',
      'feature2Title',
      'feature2Desc',
      'feature3Title',
      'feature3Desc',
      'feature4Title',
      'feature4Desc',
      'exportSoon',
      'bentoGaugeNote',
      'showcaseGaugeAria',
      'showcaseGaugeBandOk',
      'showcaseColUsed',
    ] as const) {
      expect(ptBR.landing[key], `pt-BR landing.${key} ausente`).toBeTruthy()
      expect(enUS.landing[key], `en-US landing.${key} ausente`).toBeTruthy()
    }
  })
})

describe('whenBentoGridRendered_thenTwelveColSpans', () => {
  it('grid 1/sm:2/lg:12 com tile-8 gauge + 4 tiles de feature', async () => {
    const { BentoGrid } = await import('../BentoGrid')
    const { container } = renderWithI18n(<BentoGrid />)
    const grid = container.querySelector('[data-testid="bento-grid"]')
    expect(grid, 'bento-grid ausente').not.toBeNull()
    expect(grid?.className).toMatch(/grid-cols-1/)
    expect(grid?.className).toMatch(/sm:grid-cols-2/)
    expect(grid?.className).toMatch(/lg:grid-cols-12/)
    const wide = container.querySelectorAll('.lg\\:col-span-8')
    expect(wide.length, 'tile-8 Orçamentos ausente').toBe(1)
    const narrow = container.querySelectorAll('.lg\\:col-span-4')
    expect(narrow.length, 'tiles 4col incompletos').toBeGreaterThanOrEqual(4)
  })

  it('reaproveita as 4 FEATURES com selo Em breve como span', async () => {
    const { BentoGrid } = await import('../BentoGrid')
    renderWithI18n(<BentoGrid />)
    const { default: ptBR } = await import('../../../../i18n/messages/pt-BR')
    for (const key of ['feature1Title', 'feature2Title', 'feature3Title', 'feature4Title'] as const) {
      expect(screen.getByText(ptBR.landing[key])).toBeTruthy()
    }
    const soon = screen.getByTestId('landing-export-soon')
    expect(soon.tagName).not.toBe('A')
    expect(soon.tagName).not.toBe('BUTTON')
  })

  it('gauge ok usa emerald com progressbar e aria-valuetext tabular', async () => {
    const { BentoGrid } = await import('../BentoGrid')
    const { container } = renderWithI18n(<BentoGrid usedCents={150000} limitCents={500000} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('data-band')).toBe('ok')
    expect(bar.getAttribute('aria-valuenow')).toBe('30')
    expect(bar.getAttribute('aria-valuetext') ?? '').toMatch(/30%/)
    expect(container.querySelector('[data-testid="bento-gauge-fill"]')?.className ?? '').toMatch(
      /bg-emerald-500/,
    )
    expect(container.querySelector('.tabular-nums')).not.toBeNull()
  })

  it('warning usa token var, nunca bg-amber-500; hover elevado presente', async () => {
    const { BentoGrid } = await import('../BentoGrid')
    const { container } = renderWithI18n(<BentoGrid usedCents={340000} limitCents={500000} />)
    expect(screen.getByRole('progressbar').getAttribute('data-band')).toBe('warning')
    expect(container.querySelector('[data-testid="bento-gauge-fill"]')?.className ?? '').toMatch(
      /bg-\[var\(--color-amber-500\)\]/,
    )
    expect(container.innerHTML).not.toContain('bg-amber-500')
    expect(container.innerHTML).toContain('hover:-translate-y-1')
  })

  it('limite zero rende role=status sem progressbar nem NaN', async () => {
    const { BentoGrid } = await import('../BentoGrid')
    const { container } = renderWithI18n(<BentoGrid usedCents={0} limitCents={0} />)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(container.textContent ?? '').not.toMatch(/NaN/)
    void i18n
  })
})

describe('whenBentoGridSourceAudited_thenZeroFetchZeroAmber', () => {
  it('sem supabase/fetch/sessão/innerHTML, sem bg-amber-500 literal', () => {
    const content = readFileSync('frontend/src/modules/landing/components/BentoGrid.tsx', 'utf8')
    expect(content).not.toMatch(/supabase/i)
    expect(content).not.toMatch(/useAuthStore|getSession|access_token/i)
    expect(content).not.toMatch(/fetch\(|axios|XMLHttpRequest/i)
    expect(content).not.toContain('dangerouslySetInnerHTML')
    expect(content).not.toContain('bg-amber-500')
    expect(content).toContain('lg:grid-cols-12')
    expect(content).toContain('lg:col-span-8')
    expect(content).toContain('tabular-nums')
    expect(content).toContain('motion-reduce')
  })
})
