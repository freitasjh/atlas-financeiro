// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'

import i18n from '@/i18n'
import { RequestInvitePage } from '@/pages/RequestInvitePage'

afterEach(() => cleanup())

function renderPage() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/solicitar-convite']}>
        <RequestInvitePage />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

describe('RequestInvitePage', () => {
  it('whenRendered_thenExplainsInviteOnlyWithoutForm', () => {
    const { container } = renderPage()
    expect(screen.getByRole('heading', { name: /acesso por convite/i })).toBeTruthy()
    expect(container.textContent).toContain('O Estica Grana é por convite')
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('input')).toBeNull()
    expect(container.textContent).not.toMatch(/prazo|em até|dias úteis/i)
  })

  it('whenRendered_thenOffersThreeLinksInOrderWithPushAndReplace', () => {
    const { container } = renderPage()
    const stack = container.querySelector('.flex.w-full.flex-col.gap-2')
    expect(stack).not.toBeNull()
    const links = Array.from(stack?.querySelectorAll('a') ?? [])
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/register', '/login', '/landing'])

    // 🟡-2: rótulo do 3º link vém de landing.heroCta — sem literal no JSX.
    expect(links[0].textContent).toContain(i18n.t('landing.heroCta'))
    expect(links[0].className).toMatch(/bg-primary/)
    expect(links[1].className).not.toMatch(/bg-primary/)
    expect(links[2].className).not.toMatch(/bg-primary/)
    for (const link of links) {
      expect(link.className).toMatch(/h-11/)
      expect(link.className).toMatch(/w-full/)
    }

    const source = readFileSync('src/pages/RequestInvitePage.tsx', 'utf8')
    expect(source, 'Criar conta deve usar push (sem replace)').toContain('<Link to="/register">')
    expect(source, 'Entrar mantém replace').toContain('<Link to="/login" replace>')
    expect(source, 'Voltar mantém replace').toContain('<Link to="/landing" replace>')
    expect(source, '0 literal "Criar conta" no JSX').not.toContain('Criar conta')
    expect(source, '0 chave nova sob auth.requestInvite.*').not.toContain('auth.requestInvite.create')
  })
})
