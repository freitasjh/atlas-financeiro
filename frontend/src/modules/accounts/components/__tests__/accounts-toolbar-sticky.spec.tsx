// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AccountsView } from '../AccountsView'
import type { AccountViewItem } from '../../model/view-model'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const ACCOUNT: AccountViewItem = {
  id: 'acc-1',
  nickname: 'Conta Um',
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

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenContentScrolls_thenSelectorBarSticksBelowSiteHeader', () => {
  it('barra usa top-(--header-height) com z-10, nunca top-0 (B-A1)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <AccountsView accounts={[ACCOUNT]} />
      </I18nextProvider>,
    )

    const group = screen.getByRole('group', { name: i18n.t('accounts.toolbar.viewsAndAccounts') })
    expect(group.className).toContain('sticky')
    expect(group.className).toContain('top-(--header-height)')
    expect(group.className).toContain('z-10')
    expect(group.className).not.toContain('top-0')
    // SiteHeader é z-20: a barra nunca pode competir com ele.
    expect(group.className).not.toContain('z-20')
  })
})
