// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { SelectorBar } from '../SelectorBar'
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

const ACCOUNTS = [account('acc-1', 'Conta Um'), account('acc-2', 'Conta Dois')]

function renderBar(selectedAccountId = '') {
  return render(
    <I18nextProvider i18n={i18n}>
      <SelectorBar
        accounts={ACCOUNTS}
        selectedAccountId={selectedAccountId}
        totalConsolidatedBalanceCents={300000}
        onSelectAccount={() => {}}
        onAddNewAccount={() => {}}
      />
    </I18nextProvider>,
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenConsolidatedChipRenders_thenItExposesPressedState', () => {
  it('chip consolidado tem aria-pressed true quando selecionado (B-A2)', () => {
    renderBar('')

    const consolidated = screen.getByRole('button', {
      name: new RegExp(i18n.t('accounts.selector.consolidated')),
    })
    expect(consolidated.getAttribute('aria-pressed')).toBe('true')
  })

  it('chip consolidado tem aria-pressed false quando uma conta está ativa (B-A2)', () => {
    renderBar('acc-1')

    const consolidated = screen.getByRole('button', {
      name: new RegExp(i18n.t('accounts.selector.consolidated')),
    })
    expect(consolidated.getAttribute('aria-pressed')).toBe('false')
    const active = screen.getByRole('button', { name: /Conta Um/ })
    expect(active.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('whenSelectorBarRenders_thenCarouselControlsMatchGallery', () => {
  it('expõe chevrons acessíveis de rolagem (B-A3)', () => {
    renderBar()

    expect(screen.getByRole('button', { name: i18n.t('accounts.selector.scrollLeft') })).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('accounts.selector.scrollRight') })).toBeTruthy()
  })

  it('tem divisor visual entre a ação de criação e os chips (B-A3)', () => {
    const { container } = renderBar()
    expect(container.querySelector('[data-testid="accounts-chips-divider"]')).not.toBeNull()
  })
})

describe('whenSelectorBarRenders_thenNewAccountActionLeadsTheBar', () => {
  it('CTA fica no início, shrink-0, sem sticky right-0 (B-A4)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <SelectorBar
          accounts={ACCOUNTS}
          selectedAccountId=""
          totalConsolidatedBalanceCents={300000}
          onSelectAccount={() => {}}
          onAddNewAccount={() => {}}
        />
      </I18nextProvider>,
    )

    const cta = screen.getByRole('button', { name: i18n.t('accounts.selector.newAccount') })
    expect(cta.className).toContain('shrink-0')
    expect(cta.className).toContain('min-h-11')
    expect(cta.className).not.toContain('sticky')

    const track = screen.getByTestId('accounts-chips')
    expect(track.contains(cta)).toBe(false)
    expect(
      cta.compareDocumentPosition(track) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('CTA fica antes do chip consolidado (B-A4)', () => {
    renderBar()

    const cta = screen.getByRole('button', { name: i18n.t('accounts.selector.newAccount') })
    const consolidated = screen.getByRole('button', {
      name: new RegExp(i18n.t('accounts.selector.consolidated')),
    })
    expect(
      cta.compareDocumentPosition(consolidated) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

describe('whenChevronIsUsed_thenCarouselScrolls', () => {
  it('chevrons rolam o trilho em 300px para cada lado (B-A3)', async () => {
    const user = userEvent.setup()
    const { container } = renderBar()

    const track = container.querySelector<HTMLElement>('[data-testid="accounts-chips"]')!
    const calls: Array<ScrollToOptions | number | undefined> = []
    track.scrollBy = ((opts?: ScrollToOptions | number) => {
      calls.push(opts)
    }) as typeof track.scrollBy

    await user.click(screen.getByRole('button', { name: i18n.t('accounts.selector.scrollRight') }))
    await user.click(screen.getByRole('button', { name: i18n.t('accounts.selector.scrollLeft') }))

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ left: 300, behavior: 'smooth' })
    expect(calls[1]).toEqual({ left: -300, behavior: 'smooth' })
  })
})
