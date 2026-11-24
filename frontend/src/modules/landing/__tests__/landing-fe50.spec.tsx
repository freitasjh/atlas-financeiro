// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../../i18n'
import type { ReactNode } from 'react'

function renderWithI18n(node: ReactNode) {
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </MemoryRouter>,
  )
}

afterEach(() => cleanup())

// FE-50 TDD FIRST — catálogo único + landing v2 + admin alinhado.
// 4 planos free|standard|pro|full; anual BIGINT sem float; 7 seções;
// CTAs principais → /register?plano=; secundários → /solicitar-convite?plano=;
// copy anti-cobrança; Em breve sem CTA.

describe('whenCatalogLoaded_thenFourSlugsFeaturedPro', () => {
  it('tem 4 slugs exatos com monthly BIGINT >= 0 e featured=pro', async () => {
    const { PLANS, FEATURED_SLUG } = await import('../model/catalog')
    expect(PLANS.map((p) => p.slug)).toEqual(['free', 'standard', 'pro', 'full'])
    expect(FEATURED_SLUG).toBe('pro')
    const bySlug = Object.fromEntries(PLANS.map((p) => [p.slug, p.monthlyCents]))
    expect(bySlug).toEqual({ free: 0, standard: 1990, pro: 3990, full: 6990 })
    for (const p of PLANS) {
      expect(Number.isInteger(p.monthlyCents)).toBe(true)
      expect(p.monthlyCents).toBeGreaterThanOrEqual(0)
    }
    expect(PLANS.find((p) => p.slug === 'pro')?.featured).toBe(true)
    expect(PLANS.filter((p) => p.featured)).toHaveLength(1)
  })

  it('anual == round(m*12*0.8) por plano, inteiro, sem drift', async () => {
    const { PLANS, annualCentsFor } = await import('../model/catalog')
    for (const p of PLANS) {
      const expected = Math.round(p.monthlyCents * 12 * 0.8)
      expect(annualCentsFor(p.monthlyCents)).toBe(expected)
      expect(Number.isInteger(annualCentsFor(p.monthlyCents))).toBe(true)
    }
    expect(annualCentsFor(1990)).toBe(19104)
    expect(annualCentsFor(3990)).toBe(38304)
    expect(annualCentsFor(6990)).toBe(67104)
    expect(annualCentsFor(0)).toBe(0)
  })

  it('allowlist: válido passa, inválido/ausente resolve free silencioso', async () => {
    const { isPlanSlug, resolvePlanSlug, planCtaHref } = await import('../model/catalog')
    expect(isPlanSlug('pro')).toBe(true)
    expect(isPlanSlug('free')).toBe(true)
    expect(isPlanSlug('enterprise')).toBe(false)
    expect(isPlanSlug('basic')).toBe(false)
    expect(isPlanSlug('admin')).toBe(false)
    expect(isPlanSlug(undefined)).toBe(false)
    expect(resolvePlanSlug('pro')).toBe('pro')
    expect(resolvePlanSlug('enterprise')).toBe('free')
    expect(resolvePlanSlug(undefined)).toBe('free')
    expect(resolvePlanSlug(null)).toBe('free')
    expect(resolvePlanSlug('')).toBe('free')
    for (const slug of ['free', 'standard', 'pro', 'full'] as const) {
      expect(planCtaHref(slug)).toBe(`/solicitar-convite?plano=${slug}`)
    }
  })
})

describe('whenToggleRendered_thenTwoModesNoDrift', () => {
  it('alterna mensal↔anual 2x sem drift nos 4 planos', async () => {
    const { PlanToggle } = await import('../components/PlanToggle')
    const { annualCentsFor } = await import('../model/catalog')
    renderWithI18n(<PlanToggle mode="monthly" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: /mensal/i }).getAttribute('aria-pressed')).toBe('true')
    cleanup()
    const seen = new Set<number>()
    for (const m of [0, 1990, 3990, 6990]) {
      seen.add(annualCentsFor(m))
    }
    expect(seen.size).toBe(4)
    expect(annualCentsFor(1990)).toBe(19104)
  })

  it('toggle dispara onChange e reflete aria-pressed', async () => {
    const { PlanToggle } = await import('../components/PlanToggle')
    let mode: string = 'monthly'
    const { container } = render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <PlanToggle mode={mode as 'monthly'} onChange={(m) => { mode = m }} />
        </I18nextProvider>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: /anual/i }))
    expect(mode).toBe('annual')
    expect(container.querySelector('[role="group"]')).not.toBeNull()
  })
})

describe('whenLandingV2Rendered_thenSevenSectionsInOrder', () => {
  it('7 seções na ordem com âncoras navegáveis + footer', async () => {
    const { LandingPage } = await import('../pages/LandingPage')
    const { container } = renderWithI18n(<LandingPage />)
    const sections = Array.from(container.querySelectorAll('main > section')).map((s) => s.id)
    expect(sections).toEqual(['hero', 'demo', 'prova', 'recursos', 'como-funciona', 'planos', 'faq'])
    for (const id of sections) {
      const links = document.querySelectorAll(`[data-scroll-target="${id}"]`)
      expect(links.length, `âncora #${id} sem link`).toBeGreaterThan(0)
    }
    expect(container.querySelectorAll('a[href^="#"]:not([href^="#/"])')).toHaveLength(0)
    expect(container.querySelector('footer')).not.toBeNull()
    expect(container.querySelectorAll('h1')).toHaveLength(1)
  })

  it('todo CTA principal leva para /register?plano= slug válido do catálogo', async () => {
    const { LandingPage } = await import('../pages/LandingPage')
    const { container } = renderWithI18n(<LandingPage />)
    const ctas = container.querySelectorAll('[data-testid="landing-cta"]')
    expect(ctas).toHaveLength(5)
    const hrefs = Array.from(ctas).map((cta) => cta.getAttribute('href') ?? '')
    for (const href of hrefs) {
      expect(href).toMatch(/^#\/register\?plano=(free|standard|pro|full)$/)
    }
    for (const slug of ['free', 'standard', 'pro', 'full']) {
      expect(hrefs).toContain(`#/register?plano=${slug}`)
    }
    expect(new Set(hrefs).size, 'devem existir 4 slugs distintos (hero repete free)').toBe(4)
    expect(container.querySelectorAll('[data-testid="landing-invite-cta"]')).toHaveLength(6)
    expect(container.querySelectorAll('[data-testid="landing-final-cta"]')).toHaveLength(1)
    const finalCta = container.querySelector('[data-testid="landing-final-cta"]')
    expect(finalCta?.tagName).toBe('A')
    expect(finalCta?.getAttribute('href')).toBe('#/register?plano=free')
    expect(container.querySelectorAll('[data-testid="landing-final-band"]')).toHaveLength(1)
  })

  it('exportação "Em breve" sem CTA nem link', async () => {
    const { LandingPage } = await import('../pages/LandingPage')
    const { container } = renderWithI18n(<LandingPage />)
    const soon = screen.getByTestId('landing-export-soon')
    expect(soon.textContent).toMatch(/em breve/i)
    expect(soon.tagName).not.toBe('A')
    expect(soon.tagName).not.toBe('BUTTON')
    expect(soon.querySelector('a,button')).toBeNull()
    void container
  })

  it('copy anti-cobrança: sem assinar/pagar/checkout', async () => {
    const { LandingPage } = await import('../pages/LandingPage')
    renderWithI18n(<LandingPage />)
    const text = document.body.textContent?.toLowerCase() ?? ''
    for (const banned of ['assinar', 'checkout', 'pague agora']) {
      expect(text, `copy com promessa: ${banned}`).not.toContain(banned)
    }
    expect(text).not.toMatch(/pagar/)
  })
})

describe('whenLandingV2SourceAudited_thenZeroFetchZeroLegacy', () => {
  const sources = [
    'frontend/src/modules/landing/model/catalog.ts',
    'frontend/src/modules/landing/pages/LandingPage.tsx',
    'frontend/src/modules/landing/components/PlanToggle.tsx',
    'frontend/src/modules/landing/components/FeatureCard.tsx',
    'frontend/src/modules/landing/components/LandingDemoMock.tsx',
    'frontend/src/modules/landing/components/LandingFaq.tsx',
  ]
  it('zero supabase/fetch/sessão e zero slugs legados', () => {
    for (const file of sources) {
      const content = readFileSync(file, 'utf8')
      expect(content, `${file} com supabase`).not.toMatch(/supabase/i)
      expect(content, `${file} com sessão`).not.toMatch(/useAuthStore|getSession|access_token/i)
      expect(content, `${file} com fetch`).not.toMatch(/fetch\(|axios|XMLHttpRequest/i)
      expect(content, `${file} com innerHTML`).not.toContain('dangerouslySetInnerHTML')
      expect(content, `${file} com slug legado`).not.toMatch(/starter|growth|scale/)
      expect(content, `${file} com checkout`).not.toMatch(/checkout/i)
    }
  })

  it('zero float para dinheiro (sem 0.8/parseFloat/toFixed no catálogo)', () => {
    const content = readFileSync('frontend/src/modules/landing/model/catalog.ts', 'utf8')
    expect(content).not.toMatch(/parseFloat|toFixed/)
    expect(content).not.toContain('0.8')
  })
})

describe('whenLandingV2I18n_thenPtBrEnUs', () => {
  it('chaves landing.* completas nas duas locales', async () => {
    const { default: ptBR } = await import('../../../i18n/messages/pt-BR')
    const { default: enUS } = await import('../../../i18n/messages/en-US')
    const keys = [
      'billingMonthly', 'billingAnnual', 'billingToggleLabel', 'perMonth', 'perMonthAnnual', 'totalUpfront',
      'provaTitle', 'provaSubtitle', 'recursosTitle', 'recursosSubtitle',
      'feature1Title', 'feature1Desc', 'feature4Title', 'exportSoon',
      'stepsTitle', 'stepsSubtitle', 'step1Title', 'step3Desc',
      'planFree', 'planStandard', 'planPro', 'planFull',
      'planFreeFeature1', 'planStandardFeature1', 'planProFeature1', 'planFullFeature1',
      'navProof', 'navFeatures', 'navSteps',
      'faqQ4', 'faqA4',
    ] as const
    for (const key of keys) {
      expect(ptBR.landing[key], `pt-BR landing.${key} ausente`).toBeTruthy()
      expect(enUS.landing[key], `en-US landing.${key} ausente`).toBeTruthy()
    }
  })
})

describe('whenAdminAligned_thenSameCatalog', () => {
  it('admin consome catálogo único: 4 planos, preços iguais, base local rotulada', async () => {
    const admin = await import('../../admin/model/admin')
    const catalog = await import('../model/catalog')
    expect(admin.PLANS.map((p) => p.id)).toEqual(['free', 'standard', 'pro', 'full'])
    for (const p of catalog.PLANS) {
      expect(admin.planPriceCents(p.slug)).toBe(p.monthlyCents)
    }
    expect(admin.resolvePlanId('growth')).toBe('free')
    expect(admin.resolvePlanId(undefined)).toBe('free')
    const { default: ptBR } = await import('../../../i18n/messages/pt-BR')
    expect(ptBR.admin.localBasis).toMatch(/local/i)
    for (const slug of ['free', 'standard', 'pro', 'full'] as const) {
      expect(ptBR.admin.plans[slug], `admin.plans.${slug} ausente`).toBeTruthy()
    }
  })
})

// FE-50 nits — comentário catálogo único + comparativo role="img".
describe('whenPlansShimCommented_thenFourPlansCatalog', () => {
  it('plans.ts rotula 4 planos (catálogo único), sem "3 planos"', () => {
    const content = readFileSync('frontend/src/modules/admin/model/plans.ts', 'utf8')
    expect(content).toContain('4 planos (catálogo único)')
    expect(content).not.toContain('3 planos')
  })
})

describe('whenCompareRendered_thenIconsExposedAsImg', () => {
  it('Check/Minus do comparativo expõem role="img" com aria-label preservado', async () => {
    const { LandingPage } = await import('../pages/LandingPage')
    const { container } = renderWithI18n(<LandingPage />)
    const imgs = container.querySelectorAll('td [role="img"]')
    expect(imgs.length).toBeGreaterThanOrEqual(8)
    for (const el of Array.from(imgs)) {
      expect(el.getAttribute('aria-label')).toBeTruthy()
    }
    expect(screen.getAllByRole('img').length).toBeGreaterThanOrEqual(8)
  })
})
