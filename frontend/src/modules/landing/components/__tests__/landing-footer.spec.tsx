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

// FE-05 TDD FIRST — LandingFooter 4col: Produto/Recursos/Comparar/Legal.
// Terms 1-3 + footerNote + bottom bar ano; sem CTA extra, sem seção nova.
const FOOTER_KEYS = [
  'footerColProduct',
  'footerColFeatures',
  'footerColCompare',
  'footerColLegal',
  'footerTagline',
  'footerNote',
  'termsItem1',
  'termsItem2',
  'termsItem3',
] as const

describe('whenFooterI18n_thenPtEnPairs', () => {
  it('colunas + terms + note existem nas duas locales sem cobrança', async () => {
    const { default: ptBR } = await import('../../../../i18n/messages/pt-BR')
    const { default: enUS } = await import('../../../../i18n/messages/en-US')
    for (const key of FOOTER_KEYS) {
      expect(ptBR.landing[key], `pt-BR landing.${key} ausente`).toBeTruthy()
      expect(enUS.landing[key], `en-US landing.${key} ausente`).toBeTruthy()
    }
    const all = FOOTER_KEYS.map((k) => `${ptBR.landing[k]} ${enUS.landing[k]}`.toLowerCase()).join(' ')
    for (const banned of ['assinar', 'checkout', 'pague agora']) {
      expect(all, `copy com promessa: ${banned}`).not.toContain(banned)
    }
    expect(all).not.toMatch(/pagar/)
  })
})

describe('whenLandingFooterRendered_thenFourColsTermsNote', () => {
  it('footer com 4 colunas e links com alvo de toque + foco', async () => {
    const { LandingFooter } = await import('../LandingFooter')
    const { container } = renderWithI18n(<LandingFooter />)
    expect(container.querySelector('footer[data-testid="landing-footer"]')).not.toBeNull()
    const grid = container.querySelector('[data-testid="footer-cols"]')
    expect(grid?.className).toMatch(/lg:grid-cols-4/)
    const { default: ptBR } = await import('../../../../i18n/messages/pt-BR')
    for (const key of ['footerColProduct', 'footerColFeatures', 'footerColCompare', 'footerColLegal'] as const) {
      expect(screen.getAllByText(ptBR.landing[key]).length).toBeGreaterThanOrEqual(1)
    }
    const links = container.querySelectorAll('footer a')
    expect(links.length).toBeGreaterThanOrEqual(4)
    for (const link of Array.from(links)) {
      expect(link.className).toMatch(/min-h-11/)
      expect(link.className).toMatch(/focus-visible:ring-emerald-600/)
    }
  })

  it('terms 1-3 + footerNote + ano tabular sem CTA e sem seção nova', async () => {
    const { LandingFooter } = await import('../LandingFooter')
    const { container } = renderWithI18n(<LandingFooter />)
    expect(screen.getByText(i18n.t('landing.termsItem1'))).toBeTruthy()
    expect(screen.getByText(i18n.t('landing.termsItem2'))).toBeTruthy()
    expect(screen.getByText(i18n.t('landing.termsItem3'))).toBeTruthy()
    expect(container.textContent).toContain(i18n.t('landing.footerNote'))
    expect(container.querySelector('.tabular-nums')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="landing-cta"]')).toHaveLength(0)
    expect(container.querySelector('section[id]')).toBeNull()
    expect(container.querySelector('footer [id]'), 'footer com id cria âncora').toBeNull()
  })
})

describe('whenLandingFooterSourceAudited_thenZeroFetchZeroAmber', () => {
  it('sem supabase/fetch/sessão/innerHTML, sem bg-amber-500', () => {
    const content = readFileSync('frontend/src/modules/landing/components/LandingFooter.tsx', 'utf8')
    expect(content).not.toMatch(/supabase/i)
    expect(content).not.toMatch(/useAuthStore|getSession|access_token/i)
    expect(content).not.toMatch(/fetch\(|axios|XMLHttpRequest/i)
    expect(content).not.toContain('dangerouslySetInnerHTML')
    expect(content).not.toContain('bg-amber-500')
    expect(content).toContain('tabular-nums')
    expect(content).toContain('lg:grid-cols-4')
  })
})
