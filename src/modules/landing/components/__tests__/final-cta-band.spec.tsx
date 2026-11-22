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

// FE-04 TDD FIRST — FinalCtaBand: faixa final SEM id/âncora, 1 CTA free emerald.
describe('whenFinalCtaI18n_thenPtEnPairs', () => {
  it('título/subtítulo existem nas duas locales sem cobrança', async () => {
    const { default: ptBR } = await import('../../../../i18n/messages/pt-BR')
    const { default: enUS } = await import('../../../../i18n/messages/en-US')
    for (const key of ['finalCtaTitle', 'finalCtaSubtitle'] as const) {
      expect(ptBR.landing[key], `pt-BR landing.${key} ausente`).toBeTruthy()
      expect(enUS.landing[key], `en-US landing.${key} ausente`).toBeTruthy()
    }
    const all = `${ptBR.landing.finalCtaTitle} ${ptBR.landing.finalCtaSubtitle}`.toLowerCase()
    for (const banned of ['assinar', 'checkout', 'pague agora']) {
      expect(all, `copy com promessa: ${banned}`).not.toContain(banned)
    }
    expect(all).not.toMatch(/pagar/)
    void enUS
  })
})

describe('whenFinalCtaBandRendered_thenSingleFreeCta', () => {
  it('exatamente 1 CTA para /register?plano=free em token semântico', async () => {
    const { FinalCtaBand } = await import('../FinalCtaBand')
    const { container } = renderWithI18n(<FinalCtaBand />)
    expect(container.querySelector('[data-testid="final-cta-band"]')).not.toBeNull()
    const ctas = container.querySelectorAll('a[href="/register?plano=free"]')
    expect(ctas).toHaveLength(1)
    expect(container.querySelectorAll('a,button'), 'CTA extra na band').toHaveLength(1)
    expect(ctas[0].className).toMatch(/bg-primary/)
    expect(ctas[0].className).toMatch(/hover:bg-primary\/90/)
    expect(ctas[0].className).toMatch(/min-h-1[12]/)
    expect(ctas[0].className).toMatch(/focus-visible:ring-ring/)
    expect(container.querySelector('[data-testid="landing-cta"]'), 'testid duplicado infla a contagem').toBeNull()
    expect(screen.getByText(i18n.t('landing.finalCtaTitle'))).toBeTruthy()
  })

  it('sem id e sem âncora extra (não entra em SECTION_LINKS)', async () => {
    const { FinalCtaBand } = await import('../FinalCtaBand')
    const { container } = renderWithI18n(<FinalCtaBand />)
    expect(container.querySelector('[id]'), 'band com id cria âncora extra').toBeNull()
    expect(container.querySelector('section[id]')).toBeNull()
    expect(container.querySelectorAll('h1')).toHaveLength(0)
    for (const anchor of Array.from(container.querySelectorAll('a[href^="#"]'))) {
      expect(anchor.getAttribute('href'), 'âncora extra na band').toBeNull()
    }
  })
})

describe('whenFinalCtaBandSourceAudited_thenZeroFetchZeroAmber', () => {
  it('sem supabase/fetch/sessão/innerHTML, sem bg-amber-500, sem id=', () => {
    const content = readFileSync('src/modules/landing/components/FinalCtaBand.tsx', 'utf8')
    expect(content).not.toMatch(/supabase/i)
    expect(content).not.toMatch(/useAuthStore|getSession|access_token/i)
    expect(content).not.toMatch(/fetch\(|axios|XMLHttpRequest/i)
    expect(content).not.toContain('dangerouslySetInnerHTML')
    expect(content).not.toContain('bg-amber-500')
    expect(content).not.toMatch(/bg-slate-|text-white/)
    expect(content).not.toContain(' id=')
    expect(content).not.toContain('<section id')
    expect(content, 'testid duplicado de CTA').not.toContain('data-testid="landing-cta"')
    expect(content).toContain('registerCtaHref')
  })
})
