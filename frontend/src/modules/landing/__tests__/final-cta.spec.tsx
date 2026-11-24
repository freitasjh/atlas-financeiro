// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'

import i18n from '../../../i18n'
import { LandingPage } from '../pages/LandingPage'

function renderLanding() {
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <LandingPage />
      </I18nextProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

const HREF_RE = /^#\/register\?plano=(free|standard|pro|full)$/
const INVITE_RE = /^#\/solicitar-convite\?plano=(free|standard|pro|full)$/

describe('whenFinalCtaRendered_thenSemanticAnchorAndCanonicalCounts', () => {
  it('Q4/M1: landing-final-cta é âncora <A> com href de cadastro', () => {
    const { container } = renderLanding()
    const finalCta = container.querySelector('[data-testid="landing-final-cta"]')
    expect(finalCta, 'landing-final-cta ausente').not.toBeNull()
    expect(finalCta?.tagName).toBe('A')
    expect(finalCta?.getAttribute('href')).toBe('#/register?plano=free')
    expect(finalCta?.getAttribute('href')).toMatch(HREF_RE)
    expect(container.querySelectorAll('[data-testid="landing-final-cta"]')).toHaveLength(1)
    expect(finalCta?.textContent).toContain(i18n.t('landing.heroCta'))
  })

  it('M1: testid da faixa na âncora, section renomeada landing-final-band', () => {
    const { container } = renderLanding()
    const band = container.querySelector('[data-testid="landing-final-band"]')
    expect(band, 'section da faixa sem landing-final-band').not.toBeNull()
    expect(band?.tagName).toBe('SECTION')
    expect(container.querySelectorAll('[data-testid="landing-final-band"]')).toHaveLength(1)
    expect(band?.querySelector('[data-testid="landing-final-cta"]')).not.toBeNull()
  })

  it('contagens canônicas 5 / 1 / 6 / 1 (independentes)', () => {
    const { container } = renderLanding()
    expect(container.querySelectorAll('[data-testid="landing-cta"]')).toHaveLength(5)
    expect(container.querySelectorAll('[data-testid="landing-final-cta"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="landing-invite-cta"]')).toHaveLength(6)
    expect(container.querySelectorAll('[data-testid="landing-final-band"]')).toHaveLength(1)
    const primary = Array.from(container.querySelectorAll('[data-testid="landing-cta"]')).map(
      (el) => el.getAttribute('href') ?? '',
    )
    for (const href of primary) expect(href).toMatch(HREF_RE)
    // Hero e plano free compartilham `?plano=free`: 5 âncoras, 4 slugs distintos.
    expect(new Set(primary).size).toBe(4)
    const invites = Array.from(container.querySelectorAll('[data-testid="landing-invite-cta"]')).map(
      (el) => el.getAttribute('href') ?? '',
    )
    for (const href of invites) expect(href).toMatch(INVITE_RE)
  })

  it('I5: secundário da faixa abaixo do primário, ambos h-11', () => {
    const { container } = renderLanding()
    const band = container.querySelector('[data-testid="landing-final-band"]') as HTMLElement
    const primary = band.querySelector('[data-testid="landing-final-cta"]') as HTMLElement
    const secondary = band.querySelector('[data-testid="landing-invite-cta"]') as HTMLElement
    expect(secondary).not.toBeNull()
    expect(primary.className).toMatch(/\bh-11\b/)
    expect(secondary.className).toMatch(/\bh-11\b/)
    expect(primary.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const wrapper = primary.parentElement
    expect(wrapper?.className, 'faixa não empilha primário/secundário').toMatch(/flex-col/)
    // GAP-L2C-1: nenhuma variante responsiva pode reverter para linha.
    expect(wrapper?.className, 'GAP-L2C-1: sm:flex-row reverte o empilhamento em 1280').not.toMatch(
      /\b(?:sm|md|lg|xl|2xl):flex-row\b/,
    )
  })

  it('GAP-L2C-1: empilhado em 1280 — ordem DOM e classe sem variante row', () => {
    const { container } = renderLanding()
    const band = container.querySelector('[data-testid="landing-final-band"]') as HTMLElement
    const primary = band.querySelector('[data-testid="landing-final-cta"]') as HTMLElement
    const secondary = band.querySelector('[data-testid="landing-invite-cta"]') as HTMLElement
    const wrapper = primary.parentElement as HTMLElement

    // 1280 segue as classes base: flex-col é incondicional; só `sm:*` poderia
    // virar linha. Prova de viewport real é feita no browser (H3), não aqui.
    const classes = wrapper.className.split(/\s+/)
    expect(classes, 'wrapper da faixa perdeu flex').toContain('flex')
    expect(classes, 'wrapper da faixa perdeu flex-col').toContain('flex-col')
    expect(classes.some((c) => /^(sm|md|lg|xl|2xl):flex-row$/.test(c))).toBe(false)
    expect(primary.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(primary.getAttribute('href')).toBe('#/register?plano=free')
    expect(secondary.getAttribute('href')).toBe('#/solicitar-convite?plano=free')
  })

  it('clique usa preventDefault e navega via handleNavigate', () => {
    const { container } = renderLanding()
    const finalCta = container.querySelector('[data-testid="landing-final-cta"]') as HTMLAnchorElement
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    finalCta.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(window.location.hash).toBe('#/register?plano=free')
  })

  it('I8: ArrowRight decorativo da faixa é aria-hidden', () => {
    const { container } = renderLanding()
    const band = container.querySelector('[data-testid="landing-final-band"]') as HTMLElement
    const arrow = band.querySelector('[data-testid="landing-final-cta"] svg')
    expect(arrow?.getAttribute('aria-hidden')).toBe('true')
  })
})
