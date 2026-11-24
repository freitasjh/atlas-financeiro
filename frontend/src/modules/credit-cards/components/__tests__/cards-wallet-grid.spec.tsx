// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { DEFAULT_CARD_THEME, type CreditCardView } from '../../model/credit-card'
import { CardsWalletGrid } from '../CardsWalletGrid'

function card(id: string, overrides: Partial<CreditCardView> = {}): CreditCardView {
  return {
    id,
    nickname: `Cartão ${id}`,
    brand: 'visa',
    theme: DEFAULT_CARD_THEME,
    accountId: 'acc-1',
    limitCents: 500000,
    closingDay: 10,
    dueDay: 20,
    ...overrides,
  }
}

function withI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

function renderWallet(cards: CreditCardView[]) {
  return withI18n(
    <CardsWalletGrid
      cards={cards}
      selectedCardId={cards[0]?.id ?? ''}
      invoicesByCard={{}}
      periodCode="2026-09"
      principalCardId={null}
      onSelect={vi.fn()}
      onSetPrincipal={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />,
  )
}

afterEach(() => {
  cleanup()
  void i18n.changeLanguage('pt-BR')
})

describe('whenWalletAdoptsPreviewArt_thenOneArtAndOneIdentityPerCard', () => {
  it('um preview wallet por cartão com tema, bandeira, titular e validade', () => {
    renderWallet([
      card('c-1', {
        last4: '1234',
        holderName: 'JOAO SILVA',
        expiryMmAA: '12/29',
        theme: 'emerald',
        brand: 'mastercard',
      }),
      card('c-2', { last4: null, holderName: null, expiryMmAA: null }),
    ])

    expect(screen.getAllByTestId('card-preview-root')).toHaveLength(2)
    const faces = screen.getAllByTestId('card-preview-art')
    expect(faces).toHaveLength(2)
    expect(faces[0]?.className).toContain('from-emerald-950')
    expect(screen.getByTestId('card-preview-holder').textContent).toBe('JOAO SILVA')
    expect(screen.getByTestId('card-preview-expiry').textContent).toBe('12/29')
    expect(screen.getAllByTestId('card-preview-brand-circle')).toHaveLength(2)
  })

  it('uma CardIdentity visível por cartão, dentro da arte, sem número/CVV/verso', () => {
    renderWallet([card('c-1', { last4: '1234' }), card('c-2', { last4: null })])

    const identities = screen.getAllByTestId('card-identity')
    expect(identities).toHaveLength(2)
    for (const identity of identities) {
      expect(identity.closest('[aria-hidden="true"]')).toBeTruthy()
    }
    expect(identities[0]?.textContent).toBe('•1234')
    expect(identities[1]?.textContent).toContain('••••')
    expect(screen.getByTestId('card-identity-pending').textContent).toBe(i18n.t('cards.identity.pending'))
    expect(screen.queryByTestId('card-preview-number')).toBeNull()
    expect(screen.queryByTestId('card-preview-cvv')).toBeNull()
    expect(screen.queryByTestId('card-preview-rotator')).toBeNull()
  })
})

describe('whenWalletIdentityIsExposedToAT_thenReadExactlyOncePerCard', () => {
  it('rótulo sr-only fora da arte aria-hidden traduz last4 e estado pendente uma vez', () => {
    renderWallet([card('c-1', { last4: '1234' }), card('c-2', { last4: null })])

    const labels = screen.getAllByTestId('card-preview-identity-aria')
    expect(labels).toHaveLength(2)
    for (const label of labels) {
      expect(label.className).toContain('sr-only')
      expect(label.closest('[aria-hidden="true"]')).toBeNull()
    }
    expect(screen.getByRole('img', { name: i18n.t('cards.cardAria.last4', { last4: '1234' }) })).toBeTruthy()
    expect(screen.getByRole('img', { name: i18n.t('cards.cardAria.last4Unknown') })).toBeTruthy()
  })

  it('seleção do cartão continua no botão de apelido (arte não rouba clique)', () => {
    const onSelect = vi.fn()
    withI18n(
      <CardsWalletGrid
        cards={[card('c-1', { last4: '1234' })]}
        selectedCardId=""
        invoicesByCard={{}}
        periodCode="2026-09"
        principalCardId={null}
        onSelect={onSelect}
        onSetPrincipal={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    screen.getByRole('button', { name: new RegExp(card('c-1').nickname) }).click()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('c-1')
  })
})
