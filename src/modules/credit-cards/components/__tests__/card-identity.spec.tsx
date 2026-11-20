// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { DEFAULT_CARD_THEME, type CreditCardView } from '../../model/credit-card'
import { CardSelectorBar } from '@/components/shadcn/credit-card/card-selector-bar'
import { CardsWalletGrid } from '../CardsWalletGrid'
import { CardIdentity } from '../CardIdentity'

function misleadingCard(): CreditCardView {
  return {
    id: 'c-misleading',
    nickname: 'Cartão Final 9999',
    brand: 'visa',
    theme: DEFAULT_CARD_THEME,
    accountId: 'acc-1',
    limitCents: 500000,
    closingDay: 10,
    dueDay: 20,
    last4: null,
  }
}

function withI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

afterEach(() => {
  cleanup()
  void i18n.changeLanguage('pt-BR')
})

describe('whenLast4IsNull_thenRendersHonestPendingIdentity', () => {
  it('•••• + chip cards.identity.pending, sem dígito inventado', () => {
    withI18n(<CardIdentity last4={null} />)

    const identity = screen.getByTestId('card-identity')
    expect(identity.textContent).toContain('••••')
    expect(within(identity).getByTestId('card-identity-pending').textContent).toBe(
      i18n.t('cards.identity.pending'),
    )
    expect(identity.textContent).not.toContain('1234')
  })

  it('undefined cai no mesmo estado pendente (View legada)', () => {
    withI18n(<CardIdentity last4={undefined} />)

    expect(screen.getByTestId('card-identity').textContent).toContain('••••')
  })
})

describe('whenLast4IsFilled_thenRendersMaskedDigitsTabular', () => {
  it('•1234 com font-mono tabular-nums e sem chip pendente', () => {
    withI18n(<CardIdentity last4="1234" />)

    const identity = screen.getByTestId('card-identity')
    expect(identity.textContent).toContain('•1234')
    expect(identity.className).toContain('font-mono')
    expect(identity.className).toContain('tabular-nums')
    expect(screen.queryByTestId('card-identity-pending')).toBeNull()
  })
})

describe('whenToneIsArt_thenIdentityIsContrastSafeOnDarkArt', () => {
  it('last4 presente: texto branco na arte, sem tokens de superfície', () => {
    withI18n(<CardIdentity last4="1234" tone="art" />)

    const identity = screen.getByTestId('card-identity')
    expect(identity.className).toContain('text-white')
    expect(identity.className).not.toContain('text-foreground')
    expect(identity.className).not.toContain('text-muted-foreground')
  })

  it('last4 nulo: •••• text-white/70 e badge branco translúcido, sem âmbar de superfície', () => {
    withI18n(<CardIdentity last4={null} tone="art" />)

    const identity = screen.getByTestId('card-identity')
    expect(identity.firstElementChild?.className).toContain('text-white/70')
    expect(identity.firstElementChild?.className).not.toContain('text-muted-foreground')
    const badge = screen.getByTestId('card-identity-pending')
    expect(badge.className).toContain('border-white/20')
    expect(badge.className).toContain('bg-white/10')
    expect(badge.className).toContain('text-white')
    expect(badge.className).not.toContain('text-amber-600')
  })

  it('tone omitido permanece surface (backward compatible seletor/legado)', () => {
    withI18n(<CardIdentity last4="1234" />)

    expect(screen.getByTestId('card-identity').className).toContain('text-foreground')
    expect(screen.getByTestId('card-identity').className).not.toContain('text-white')
  })
})

describe('whenNicknameHasDigits_thenNoBrandOrNameInference', () => {
  it('seletor: nickname "Cartão Final 9999" + last4 null exibe •••• e nunca 9999 como identidade', () => {
    withI18n(
      <CardSelectorBar
        cards={[
          {
            id: 'c-misleading',
            nickname: 'Cartão Final 9999',
            last4: null,
            theme: DEFAULT_CARD_THEME,
            amountCents: 0,
          },
        ]}
        selectedCardId="c-misleading"
        totalConsolidatedCents={0}
        onSelectCard={vi.fn()}
        onAddNewCard={vi.fn()}
      />,
    )

    const chip = screen.getByRole('button', { name: /Cartão Final 9999/ })
    const identity = within(chip).getByText(/• ••••/)
    expect(identity.textContent).not.toContain('9999')
  })

  it('wallet: nickname "Cartão Final 9999" + last4 null exibe •••• e nunca 9999 como identidade', () => {
    withI18n(
      <CardsWalletGrid
        cards={[misleadingCard()]}
        selectedCardId="c-misleading"
        invoicesByCard={{}}
        periodCode="2026-09"
        principalCardId={null}
        onSelect={vi.fn()}
        onSetPrincipal={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const identity = screen.getByTestId('card-identity')
    expect(identity.textContent).toContain('••••')
    expect(identity.textContent).not.toContain('9999')
  })
})

describe('whenLocaleChanges_thenPendingLabelTranslates', () => {
  it('pt-BR "identidade pendente" → en-US "identity pending"', async () => {
    await i18n.changeLanguage('pt-BR')
    const { unmount } = withI18n(<CardIdentity last4={null} />)
    expect(screen.getByTestId('card-identity-pending').textContent).toBe('identidade pendente')
    unmount()

    await i18n.changeLanguage('en-US')
    withI18n(<CardIdentity last4={null} />)
    expect(screen.getByTestId('card-identity-pending').textContent).toBe('identity pending')
    expect(i18n.t('cards.identity.pending')).toBe('identity pending')
  })
})
