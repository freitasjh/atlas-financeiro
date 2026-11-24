// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { CARD_BRANDS, CARD_THEMES, type CardBrand, type CardTheme } from '../../model/credit-card'
import { CreditCardPreview } from '../CreditCardPreview'

function withI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

afterEach(() => {
  cleanup()
  void i18n.changeLanguage('pt-BR')
})

const THEME_ART: Record<CardTheme, string> = {
  midnight: 'from-neutral-900 via-neutral-800 to-black text-white border-neutral-700/60',
  emerald: 'from-emerald-950 via-emerald-900 to-neutral-950 text-white border-emerald-700/60',
  violet: 'from-violet-950 via-purple-900 to-neutral-950 text-white border-purple-700/60',
  platinum: 'from-slate-700 via-neutral-600 to-slate-800 text-white border-slate-500/60',
  rose_gold: 'from-rose-950 via-rose-900 to-neutral-900 text-white border-rose-700/60',
}

describe('whenDialogVariantRenders_thenLiveMirrorsNumberHolderExpiryAndCvv', () => {
  it('PAN vazio mostra placeholder •••• e titular/validade vazios mostram placeholders i18n', () => {
    withI18n(
      <CreditCardPreview
        variant="dialog"
        number=""
        holderName=""
        expiry=""
        cvv=""
        theme="platinum"
        brand="visa"
        isFlipped={false}
      />,
    )

    expect(screen.getByTestId('card-preview-number').textContent).toBe('•••• •••• •••• ••••')
    expect(screen.getByTestId('card-preview-holder').textContent).toBe(i18n.t('cards.preview.holderPlaceholder'))
    expect(screen.getByTestId('card-preview-expiry').textContent).toBe(i18n.t('cards.preview.expiryPlaceholder'))
    expect(screen.getByTestId('card-preview-cvv').textContent).toBe('•••')
  })

  it('espelha cada keystroke sem debounce: número, titular em upper-case, validade e CVV', () => {
    withI18n(
      <CreditCardPreview
        variant="dialog"
        number="4111 1111 1111 1111"
        holderName="joao silva"
        expiry="12/29"
        cvv="123"
        theme="midnight"
        brand="visa"
        isFlipped={false}
      />,
    )

    expect(screen.getByTestId('card-preview-number').textContent).toBe('4111 1111 1111 1111')
    expect(screen.getByTestId('card-preview-holder').textContent).toBe('JOAO SILVA')
    expect(screen.getByTestId('card-preview-expiry').textContent).toBe('12/29')
    expect(screen.getByTestId('card-preview-cvv').textContent).toBe('123')
  })

  it('número curto é preenchido com bullets agrupados 4-4-4-4', () => {
    withI18n(
      <CreditCardPreview
        variant="dialog"
        number="4111"
        holderName="A"
        expiry="01/30"
        cvv="9"
        theme="emerald"
        brand="visa"
        isFlipped={false}
      />,
    )
    expect(screen.getByTestId('card-preview-number').textContent).toBe('4111 •••• •••• ••••')
  })
})

describe('whenFlipIsControlled_thenRotatorReflectsIsFlipped', () => {
  it('isFlipped=true gira o rotador e respeita reduced-motion', () => {
    withI18n(
      <CreditCardPreview
        variant="dialog"
        number="4111111111111111"
        holderName="JOAO"
        expiry="12/29"
        cvv="123"
        theme="violet"
        brand="visa"
        isFlipped
      />,
    )
    const rotator = screen.getByTestId('card-preview-rotator')
    expect(rotator.className).toContain('rotate-y-180')
    expect(rotator.className).toContain('transform-style-preserve-3d')
    expect(rotator.className).toContain('motion-reduce:transition-none')
  })

  it('isFlipped=false mantém rotate-y-0', () => {
    withI18n(
      <CreditCardPreview
        variant="dialog"
        number=""
        holderName=""
        expiry=""
        cvv=""
        theme="platinum"
        brand="other"
        isFlipped={false}
      />,
    )
    expect(screen.getByTestId('card-preview-rotator').className).toContain('rotate-y-0')
  })
})

describe('whenThemesAndBrandsAreCopiedAsData_thenAllFivesAndSixHold', () => {
  it('cada um dos 5 temas aplica a classe de arte congelada', () => {
    for (const theme of CARD_THEMES) {
      const { unmount } = withI18n(
        <CreditCardPreview
          variant="dialog"
          number=""
          holderName=""
          expiry=""
          cvv=""
          theme={theme}
          brand="other"
          isFlipped={false}
        />,
      )
      const arts = screen.getAllByTestId('card-preview-art')
      expect(arts.length).toBe(2)
      for (const art of arts) expect(art.className).toContain(THEME_ART[theme])
      unmount()
    }
  })

  it('cada uma das 6 bandeiras renderiza sua marca (fallback other = CARD)', () => {
    const expected: Record<CardBrand, string> = {
      visa: 'VISA',
      mastercard: '',
      elo: 'elo',
      amex: 'AMEX',
      hipercard: 'HIPER',
      other: 'CARD',
    }
    for (const brand of CARD_BRANDS) {
      const { unmount } = withI18n(
        <CreditCardPreview
          variant="dialog"
          number=""
          holderName=""
          expiry=""
          cvv=""
          theme="midnight"
          brand={brand}
          isFlipped={false}
        />,
      )
      if (brand === 'mastercard') {
        expect(screen.getAllByTestId('card-preview-brand-circle')).toHaveLength(4)
      } else {
        expect(screen.getAllByTestId('card-preview-brand').map((n) => n.textContent).join()).toContain(
          expected[brand],
        )
      }
      unmount()
    }
  })

  it('textos auxiliares usam no mínimo text-white/70 (AA em platinum)', () => {
    withI18n(
      <CreditCardPreview
        variant="dialog"
        number=""
        holderName=""
        expiry=""
        cvv=""
        theme="platinum"
        brand="other"
        isFlipped={false}
      />,
    )
    for (const id of ['card-preview-holder-caption', 'card-preview-expiry-caption', 'card-preview-cvv-caption']) {
      expect(screen.getByTestId(id).className).toContain('text-white/70')
    }
  })
})

describe('whenWalletVariantRenders_thenIdentityIsPciSafeWithoutCvv', () => {
  it('last4 nulo => •••• + pending, sem dígito inferido nem CVV', () => {
    withI18n(
      <CreditCardPreview
        variant="wallet"
        last4={null}
        holderName={null}
        expiry={null}
        theme="platinum"
        brand="visa"
      />,
    )
    const identity = screen.getByTestId('card-identity')
    expect(identity.textContent).toContain('••••')
    expect(screen.getByTestId('card-identity-pending').textContent).toBe(i18n.t('cards.identity.pending'))
    expect(screen.queryByTestId('card-preview-cvv')).toBeNull()
    expect(screen.queryByTestId('card-preview-rotator')).toBeNull()
  })

  it('identidade ocupa o slot do meio da arte, sem absolute sobre titular/validade', () => {
    withI18n(
      <CreditCardPreview
        variant="wallet"
        last4="1234"
        holderName="JOAO SILVA"
        expiry="12/29"
        theme="platinum"
        brand="visa"
      />,
    )

    const identity = screen.getByTestId('card-identity')
    const holder = screen.getByTestId('card-preview-holder')
    const expiryValue = screen.getByTestId('card-preview-expiry')
    const art = screen.getByTestId('card-preview-art')
    const slot = identity.parentElement

    expect(slot?.className).toContain('my-auto')
    expect(slot?.className).toContain('py-1')
    expect(slot?.className).not.toContain('absolute')
    expect(slot?.className).not.toContain('bottom-')
    expect(slot?.className).not.toContain('left-')
    expect(slot?.parentElement).toBe(art)
    expect(holder.parentElement?.parentElement?.parentElement).toBe(art)
    expect(expiryValue.parentElement?.parentElement?.parentElement).toBe(art)
    expect(slot).not.toBe(holder.parentElement)
  })

  it('last4 string vazia cai em pendente, sem • vazio nem label com dígito', () => {
    withI18n(
      <CreditCardPreview variant="wallet" last4="" holderName={null} expiry={null} theme="platinum" brand="visa" />,
    )

    expect(screen.getByTestId('card-identity').textContent).toContain('••••')
    expect(screen.getByTestId('card-identity-pending')).toBeTruthy()
    expect(screen.getByTestId('card-preview-identity-aria').getAttribute('aria-label')).toBe(
      i18n.t('cards.cardAria.last4Unknown'),
    )
  })

  it('last4 presente => •1234, titular/validade em font-mono tabular-nums', () => {
    withI18n(
      <CreditCardPreview
        variant="wallet"
        last4="1234"
        holderName="JOAO SILVA"
        expiry="12/29"
        theme="emerald"
        brand="mastercard"
      />,
    )
    expect(screen.getByTestId('card-identity').textContent).toBe('•1234')
    expect(screen.getByTestId('card-preview-holder').textContent).toBe('JOAO SILVA')
    expect(screen.getByTestId('card-preview-expiry').textContent).toBe('12/29')
    for (const id of ['card-preview-holder', 'card-preview-expiry']) {
      expect(screen.getByTestId(id).className).toContain('tabular-nums')
    }
    expect(screen.queryByTestId('card-preview-cvv')).toBeNull()
  })
})

describe('whenWalletExposesIdentityToAT_thenLabelLivesOutsideAriaHiddenArt', () => {
  it('last4 presente: rótulo sr-only cards.cardAria.last4 fora da arte oculta', () => {
    withI18n(
      <CreditCardPreview variant="wallet" last4="1234" holderName={null} expiry={null} theme="platinum" brand="visa" />,
    )

    expect(screen.getByTestId('card-preview-root').getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByTestId('card-identity').closest('[aria-hidden="true"]')).toBeTruthy()
    const label = screen.getByTestId('card-preview-identity-aria')
    expect(label.className).toContain('sr-only')
    expect(label.closest('[aria-hidden="true"]')).toBeNull()
    expect(screen.getByRole('img', { name: i18n.t('cards.cardAria.last4', { last4: '1234' }) })).toBeTruthy()
  })

  it('last4 nulo: rótulo sr-only cards.cardAria.last4Unknown fora da arte oculta', () => {
    withI18n(
      <CreditCardPreview variant="wallet" last4={null} holderName={null} expiry={null} theme="platinum" brand="visa" />,
    )

    expect(screen.getByTestId('card-preview-identity-aria').textContent).toBe('')
    expect(screen.getByRole('img', { name: i18n.t('cards.cardAria.last4Unknown') })).toBeTruthy()
  })
})

describe('whenChipVariantRenders_thenDecorativeOnly', () => {
  it('aria-hidden + pointer-events-none, sem número/last4/titular/validade/CVV', () => {
    withI18n(<CreditCardPreview variant="chip" theme="rose_gold" brand="elo" />)
    const root = screen.getByTestId('card-preview-root')
    expect(root.getAttribute('aria-hidden')).toBe('true')
    expect(root.className).toContain('pointer-events-none')
    expect(root.className).toContain('w-12')
    expect(screen.queryByTestId('card-identity')).toBeNull()
    expect(screen.queryByTestId('card-preview-holder')).toBeNull()
    expect(screen.queryByTestId('card-preview-expiry')).toBeNull()
    expect(screen.queryByTestId('card-preview-cvv')).toBeNull()
    expect(screen.queryByTestId('card-preview-number')).toBeNull()
  })
})

describe('whenContractIsCompiled_thenSensitivePropsAndClassNameAreImpossible', () => {
  it('className não é exposto (confinamento da arte)', () => {
    withI18n(
      // @ts-expect-error className não pertence à interface congelada (ADR-006 item 1)
      <CreditCardPreview variant="chip" theme="platinum" brand="visa" className="bg-red-500" />,
    )
  })

  it('wallet rejeita number/cvv/isFlipped em tempo de compilação', () => {
    withI18n(
      // @ts-expect-error number/cvv existem só na variante dialog
      <CreditCardPreview variant="wallet" last4="1234" number="4111111111111111" cvv="123" theme="platinum" brand="visa" />,
    )
    withI18n(
      // @ts-expect-error isFlipped?: never fora do dialog
      <CreditCardPreview variant="chip" theme="platinum" brand="visa" isFlipped />,
    )
  })
})
