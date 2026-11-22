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

// FE-50 — landing v2: 7 seções + pricing com toggle + FAQ 4 itens.
// Sem promessa de cobrança, sem fetch/sessão, sem literal, CTA ?plano=.
const S8_SOURCES = [
  'src/modules/landing/pages/LandingPage.tsx',
  'src/modules/landing/components/LandingDemoMock.tsx',
  'src/modules/landing/components/LandingFaq.tsx',
]

describe('whenS8Rendered_thenSevenSectionsPlusFooter', () => {
  it('hero, demo, prova, recursos, como-funciona, planos, faq e footer presentes', async () => {
    const { LandingPage } = await import('../pages/LandingPage')
    const { container } = renderWithI18n(<LandingPage />)
    for (const id of ['hero', 'demo', 'prova', 'recursos', 'como-funciona', 'planos', 'faq']) {
      expect(document.getElementById(id), `seção #${id} ausente`).not.toBeNull()
      const links = document.querySelectorAll(`[data-scroll-target="${id}"]`)
      expect(links.length, `âncora #${id} sem link`).toBeGreaterThan(0)
    }
    const strays = container.querySelectorAll('a[href^="#"]:not([href^="#/"])')
    expect(strays, 'âncora crua (#sem-barra) vira rota no hash router').toHaveLength(0)
    expect(container.querySelector('footer')).not.toBeNull()
    expect(container.querySelector('main')).not.toBeNull()
    expect(container.querySelectorAll('h1')).toHaveLength(1)
  })

  it('todo CTA principal leva para /register?plano= (convite segue no secundário)', async () => {
    const { LandingPage } = await import('../pages/LandingPage')
    const { container } = renderWithI18n(<LandingPage />)
    const ctas = container.querySelectorAll('[data-testid="landing-cta"]')
    expect(ctas).toHaveLength(5)
    const hrefs = Array.from(ctas).map((cta) => cta.getAttribute('href') ?? '')
    for (const href of hrefs) {
      expect(href).toMatch(/^#\/register\?plano=(free|standard|pro|full)$/)
    }
    for (const slug of ['free', 'standard', 'pro', 'full']) {
      expect(hrefs, `CTA real do plano ${slug} ausente`).toContain(`#/register?plano=${slug}`)
    }
    expect(new Set(hrefs).size, 'devem existir 4 slugs distintos (hero repete free)').toBe(4)
    expect(container.querySelectorAll('[data-testid="landing-invite-cta"]')).toHaveLength(6)
    expect(container.querySelectorAll('[data-testid="landing-final-cta"]')).toHaveLength(1)
    expect(container.querySelectorAll('.bg-amber-500')).toHaveLength(0)
  })

  it('copy sem promessa de cobrança ("assinar", "checkout", "pague agora", "pagar")', async () => {
    const { LandingPage } = await import('../pages/LandingPage')
    renderWithI18n(<LandingPage />)
    const text = document.body.textContent?.toLowerCase() ?? ''
    for (const banned of ['assinar', 'checkout', 'pague agora']) {
      expect(text, `copy com promessa: ${banned}`).not.toContain(banned)
    }
    expect(text).not.toMatch(/pagar/)
  })
})

describe('whenS8DemoInteractive_thenMockMarkedNoFetch', () => {
  it('demo marcada como demonstração e filtra localmente sem fetch', async () => {
    const { LandingDemoMock } = await import('../components/LandingDemoMock')
    const { container } = renderWithI18n(<LandingDemoMock />)
    expect(screen.getByText(new RegExp(i18n.t('landing.demoBadge'), 'i'))).toBeTruthy()
    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBeGreaterThan(0)
    const rowsBefore = container.querySelectorAll('tbody tr').length
    fireEvent.click(screen.getByRole('button', { name: new RegExp(i18n.t('landing.demoFilterIncome'), 'i') }))
    const rowsAfter = container.querySelectorAll('tbody tr').length
    expect(rowsAfter).toBeLessThanOrEqual(rowsBefore)
    expect(rowsAfter).toBeGreaterThan(0)
    expect(container.querySelector('.tabular-nums')).not.toBeNull()
  })

  it('filtro sem resultado rende StateBlock empty (edge)', async () => {
    const { LandingDemoMock } = await import('../components/LandingDemoMock')
    renderWithI18n(<LandingDemoMock rows={[]} />)
    expect(screen.getByText('Nenhum item encontrado')).toBeTruthy()
  })
})

describe('whenS8FaqRendered_thenAccordionI18n', () => {
  it('4 perguntas via t() nas duas locales, abre/fecha sem reload', async () => {
    const { default: ptBR } = await import('../../../i18n/messages/pt-BR')
    const { default: enUS } = await import('../../../i18n/messages/en-US')
    for (const key of ['faqQ1', 'faqA1', 'faqQ2', 'faqA2', 'faqQ3', 'faqA3', 'faqQ4', 'faqA4'] as const) {
      expect(ptBR.landing[key], `pt-BR landing.${key} ausente`).toBeTruthy()
      expect(enUS.landing[key], `en-US landing.${key} ausente`).toBeTruthy()
    }
    const { LandingFaq } = await import('../components/LandingFaq')
    renderWithI18n(<LandingFaq />)
    const q1 = screen.getByRole('button', { name: new RegExp(ptBR.landing.faqQ1.slice(0, 20).replace(/[?().]/g, ''), 'i') })
    expect(q1.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(q1)
    expect(q1.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(ptBR.landing.faqA1)).toBeTruthy()
  })
})

describe('whenS8SourceAudited_thenNoFetchNoSessionNoLiteral', () => {
  it('zero supabase/fetch/sessão nos arquivos landing', () => {
    for (const file of S8_SOURCES) {
      const content = readFileSync(file, 'utf8')
      expect(content, `${file} com supabase`).not.toMatch(/supabase/i)
      expect(content, `${file} com sessão`).not.toMatch(/useAuthStore|getSession|access_token/i)
      expect(content, `${file} com fetch`).not.toMatch(/fetch\(|axios|XMLHttpRequest/i)
      expect(content, `${file} com innerHTML`).not.toContain('dangerouslySetInnerHTML')
    }
  })

  it('zero literal de copy em pt-BR nos arquivos landing (só chaves landing.*)', () => {
    const banned = [
      'Controle financeiro', 'Perguntas frequentes', 'Demonstração',
      'Por que sair', 'Planos simples',
    ]
    for (const file of S8_SOURCES) {
      const content = readFileSync(file, 'utf8')
      for (const literal of banned) {
        expect(content, `${file} com literal: ${literal}`).not.toContain(literal)
      }
    }
  })
})
