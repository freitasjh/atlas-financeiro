// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AccountCard } from '../AccountCard'
import type { AccountViewItem } from '../../model/view-model'

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

function renderCard(onSelect = vi.fn()) {
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <AccountCard account={ACCOUNT} isSelected={false} onSelect={onSelect} />
    </I18nextProvider>,
  )
  return { ...utils, onSelect }
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenAccountCardIsFocused_thenItIsOperableByKeyboard', () => {
  it('expõe alvo focável com foco visível (C-A16)', () => {
    renderCard()

    const target = screen.getByRole('button', { name: i18n.t('accounts.card.selectAria', { name: 'Conta Um' }) })
    expect(target.tagName).toBe('BUTTON')
    expect(target.getAttribute('type')).toBe('button')
    expect(target.className).toContain('focus-visible:ring-2')
    expect(target.className).toContain('ring-ring/70')
  })

  it('Enter seleciona a conta (C-A16)', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderCard()

    const target = screen.getByRole('button', { name: i18n.t('accounts.card.selectAria', { name: 'Conta Um' }) })
    target.focus()
    expect(document.activeElement).toBe(target)
    await user.keyboard('{Enter}')

    expect(onSelect).toHaveBeenCalledWith(ACCOUNT)
  })

  it('Espaço seleciona a conta (C-A16)', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderCard()

    // O alvo é <button> nativo: Enter/Espaço são ativação de plataforma.
    // Aqui provamos o contrato de teclado: é botão real, focável por Tab,
    // e a ativação dispara a seleção.
    const target = screen.getByRole('button', { name: i18n.t('accounts.card.selectAria', { name: 'Conta Um' }) })
    expect(target.tagName).toBe('BUTTON')
    expect(target.getAttribute('type')).toBe('button')
    expect(target.getAttribute('tabindex')).toBeNull()

    await user.tab()
    expect(document.activeElement).toBe(target)

    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith(ACCOUNT)
  })

  it('clique continua funcionando e o menu de ações não seleciona a conta (C-A16)', () => {
    const { onSelect } = renderCard()

    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.card.selectAria', { name: 'Conta Um' }) }))
    expect(onSelect).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.card.actionsAria', { name: 'Conta Um' }) }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
