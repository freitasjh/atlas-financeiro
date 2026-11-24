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

// FE-02 TDD FIRST — ProofStrip: pills de capacidades (texto) + métricas atuais.
// PM veto depoimentos nominais: sem blockquote, sem nomes, sem claims de marca.
const PROOF_KEYS = ['proofPill1', 'proofPill2', 'proofPill3', 'proofPill4'] as const

describe('whenProofI18n_thenPtEnPairs', () => {
  it('pills existem em pt-BR e en-US sem termo de cobrança', async () => {
    const { default: ptBR } = await import('../../../../i18n/messages/pt-BR')
    const { default: enUS } = await import('../../../../i18n/messages/en-US')
    for (const key of PROOF_KEYS) {
      expect(ptBR.landing[key], `pt-BR landing.${key} ausente`).toBeTruthy()
      expect(enUS.landing[key], `en-US landing.${key} ausente`).toBeTruthy()
    }
    for (const key of ['heroStat1Value', 'heroStat1Label', 'heroStat2Value', 'heroStat3Label'] as const) {
      expect(ptBR.landing[key], `pt-BR landing.${key} ausente`).toBeTruthy()
      expect(enUS.landing[key], `en-US landing.${key} ausente`).toBeTruthy()
    }
    const all = PROOF_KEYS.map((k) => `${ptBR.landing[k]} ${enUS.landing[k]}`.toLowerCase()).join(' ')
    for (const banned of ['assinar', 'checkout', 'pague agora']) {
      expect(all, `copy com promessa: ${banned}`).not.toContain(banned)
    }
    expect(all).not.toMatch(/pagar/)
  })
})

describe('whenProofStripRendered_thenPillsPlusMetrics', () => {
  it('4 pills de capacidade como texto (sem link, sem marca real)', async () => {
    const { ProofStrip } = await import('../ProofStrip')
    const { container } = renderWithI18n(<ProofStrip />)
    const strip = container.querySelector('[data-testid="proof-strip"]')
    expect(strip, 'proof-strip ausente').not.toBeNull()
    const { default: ptBR } = await import('../../../../i18n/messages/pt-BR')
    for (const key of PROOF_KEYS) {
      expect(screen.getByText(ptBR.landing[key])).toBeTruthy()
    }
    expect(strip?.querySelector('a,button')).toBeNull()
    expect(container.querySelector('blockquote')).toBeNull()
  })

  it('3 métricas atuais com tabular-nums e sem nova âncora', async () => {
    const { ProofStrip } = await import('../ProofStrip')
    const { container } = renderWithI18n(<ProofStrip />)
    expect(container.querySelector('section[id]')).toBeNull()
    expect(container.querySelectorAll('h1')).toHaveLength(0)
    expect(container.querySelector('[data-testid="landing-cta"]')).toBeNull()
    const numbers = container.querySelectorAll('.tabular-nums')
    expect(numbers.length).toBeGreaterThanOrEqual(3)
  })
})

describe('whenProofStripSourceAudited_thenZeroFetchZeroAmber', () => {
  it('sem supabase/fetch/sessão/innerHTML, sem bg-amber-500, com tabular-nums', () => {
    const content = readFileSync('frontend/src/modules/landing/components/ProofStrip.tsx', 'utf8')
    expect(content).not.toMatch(/supabase/i)
    expect(content).not.toMatch(/useAuthStore|getSession|access_token/i)
    expect(content).not.toMatch(/fetch\(|axios|XMLHttpRequest/i)
    expect(content).not.toContain('dangerouslySetInnerHTML')
    expect(content).not.toContain('bg-amber-500')
    expect(content).toContain('tabular-nums')
    expect(content).toContain('data-testid="proof-strip"')
  })
})
