// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AccountsView } from '../AccountsView'
import type { AccountViewItem } from '../../model/view-model'

function account(id: string, name: string): AccountViewItem {
  return {
    id,
    nickname: name,
    institution: 'itau',
    type: 'checking',
    agency: '0001',
    accountNumber: '12345',
    accountDigit: '0',
    currentBalanceCents: 100000,
    reconciledBalanceCents: 100000,
    blockedBalanceCents: 0,
    isDefault: false,
    connectionStatus: 'connected',
  }
}

const EIGHT = Array.from({ length: 8 }, (_, i) => account(`acc-${i + 1}`, `Conta ${i + 1}`))

function renderWithI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenEightAccountsRendered_thenToggleHugsContentWithoutGap', () => {
  it('alternador tem largura do conteúdo (w-fit/shrink-0) e não estica', () => {
    renderWithI18n(<AccountsView accounts={EIGHT} />)

    const toggle = screen.getByRole('radio', { name: i18n.t('accounts.viewStatements') }).parentElement!
    expect(toggle.className).toContain('w-fit')
    expect(toggle.className).toContain('shrink-0')
    expect(toggle.className).not.toContain('self-auto')
  })
})

describe('whenEightAccountsRendered_thenChipsScrollHorizontally', () => {
  it('container dos chips rola em x sem crescer com N contas', () => {
    const { container } = renderWithI18n(<AccountsView accounts={EIGHT} />)

    const group = screen.getByRole('group', { name: i18n.t('accounts.toolbar.viewsAndAccounts') })
    expect(group.className).toContain('min-w-0')
    expect(group.className).toContain('max-w-full')

    const chips = container.querySelector('[data-testid="accounts-chips"]')!
    expect(chips.className).toContain('overflow-x-auto')
    expect(chips.className).toContain('min-w-0')
    expect(chips.className).toContain('max-w-full')
  })
})

describe('whenEightAccountsRendered_thenNewAccountStaysReachable', () => {
  it('botão Nova Conta segue visível/acessível com N contas', () => {
    renderWithI18n(<AccountsView accounts={EIGHT} />)

    const cta = screen.getByRole('button', { name: i18n.t('accounts.selector.newAccount') })
    expect(cta).toBeTruthy()
    expect(cta.className).toContain('shrink-0')
    expect(cta.className).toContain('min-h-11')
  })
})

describe('whenTitleRowRendered_thenToggleSitsBesideTitle', () => {
  it('toggle fica na linha do título (w-fit, self-end no sm), não empilhado sobre os chips', () => {
    const { container } = renderWithI18n(<AccountsView accounts={EIGHT} />)

    const toggle = container.querySelector('[data-testid="accounts-toggle"]')!
    expect(toggle.className).toContain('w-fit')
    expect(toggle.className).toContain('shrink-0')
    // mesma linha do título: pai da toggle-row contém o h1
    expect(toggle.parentElement!.querySelector('h1')).toBeTruthy()
    // chips ficam em linha própria abaixo (irmã da linha do título, não irmã do toggle)
    const chips = container.querySelector('[data-testid="accounts-chips"]')!
    expect(chips.parentElement).not.toBe(toggle.parentElement)
  })
})

describe('whenEightAccountsRendered_thenChipsDoNotSqueeze', () => {
  it('todos os cards têm shrink-0 e o scroll-x é real', () => {
    const { container } = renderWithI18n(<AccountsView accounts={EIGHT} />)

    const chips = container.querySelector('[data-testid="accounts-chips"]')!
    expect(chips.className).toContain('overflow-x-auto')
    expect(chips.className).toContain('flex-nowrap')

    const chipButtons = chips.querySelectorAll(':scope > button')
    // Trilho = apenas as 8 contas; consolidado e "+ Nova Conta" vivem no
    // cabeçalho fixo da barra (B-A3/B-A4, paridade com a vitrine).
    expect(chipButtons.length).toBe(8)
    chipButtons.forEach((btn) => {
      expect(btn.className).toContain('shrink-0')
    })
  })

  it('consolidado e CTA ficam fora do trilho (sempre visíveis)', () => {
    const { container } = renderWithI18n(<AccountsView accounts={EIGHT} />)

    const chips = container.querySelector('[data-testid="accounts-chips"]')!
    const consolidated = screen.getByRole('button', {
      name: new RegExp(i18n.t('accounts.selector.consolidated')),
    })
    const cta = screen.getByRole('button', { name: i18n.t('accounts.selector.newAccount') })

    expect(chips.contains(consolidated)).toBe(false)
    expect(chips.contains(cta)).toBe(false)
    expect(consolidated.className).toContain('shrink-0')
  })
})
