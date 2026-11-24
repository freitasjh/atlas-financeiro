// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AddCardDialog } from '../AddCardDialog'
import { EditCardDialog } from '../EditCardDialog'
import { DeleteCardDialog } from '../DeleteCardDialog'
import { useCardForm } from '../CardFormFields'
import { DEFAULT_CARD_THEME, type CreditCardView } from '../../model/credit-card'

const ACCOUNTS = [{ id: 'acc-1', name: 'Conta Corrente' }]

function renderWithI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenAddCardSubmitsEmpty_thenValidationErrorAndFocus', () => {
  it('exibe erro de nome e foca o primeiro inválido', async () => {
    const onSubmit = vi.fn()
    renderWithI18n(<AddCardDialog open onOpenChange={() => {}} accounts={ACCOUNTS} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole('button', { name: i18n.t('cards.create') }))

    await waitFor(() => {
      expect(screen.getByText(i18n.t('cards.nameError'))).toBeTruthy()
    })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.activeElement?.getAttribute('name')).toBe('nickname')
  })
})

describe('whenTypingCardNumber_thenBrandIsAutoDetected', () => {
  it('detecta Visa pelo BIN', async () => {
    renderWithI18n(<AddCardDialog open onOpenChange={() => {}} accounts={ACCOUNTS} onSubmit={vi.fn()} />)

    const numberInput = screen.getByLabelText(i18n.t('cards.cardEnding'))
    fireEvent.change(numberInput, { target: { value: '4111111111111111' } })

    await waitFor(() => {
      expect(screen.getByText('Visa')).toBeTruthy()
    })
  })
})

describe('whenEditDialogOpens_thenFieldsArePrefilled', () => {
  it('pré-preenche apelido, limite e ciclo', () => {
    const target: CreditCardView = {
      id: 'c-1',
      nickname: 'Nubank Final 1234',
      brand: 'mastercard',
      theme: DEFAULT_CARD_THEME,
      accountId: 'acc-1',
      limitCents: 150000,
      closingDay: 10,
      dueDay: 20,
    }
    renderWithI18n(
      <EditCardDialog open onOpenChange={() => {}} card={target} accounts={ACCOUNTS} onSubmit={vi.fn()} />,
    )

    expect((screen.getByLabelText(/Nome/) as HTMLInputElement).value).toBe('Nubank Final 1234')
    expect((screen.getByLabelText(/Limite/) as HTMLInputElement).value).toContain('1.500')
  })
})

describe('whenDeleteIsBlockedByHistory_thenArchiveIsOffered', () => {
  it('exibe erro tipado e botão de arquivar', async () => {
    const onArchive = vi.fn()
    renderWithI18n(
      <DeleteCardDialog
        open
        onOpenChange={() => {}}
        cardName="Nubank"
        error="card-has-history"
        isDeleting={false}
        onConfirm={() => {}}
        onArchive={onArchive}
      />,
    )

    expect(screen.getByText(i18n.t('cards.removeBlocked'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: i18n.t('cards.archive.action') }))
    expect(onArchive).toHaveBeenCalledTimes(1)
  })
})

describe('whenCardNumberFailsLuhn_thenNamedErrorWithoutWrite', () => {
  it('PAN inválido mostra invalid-card-number e não chama onSubmit', async () => {
    const onSubmit = vi.fn()
    renderWithI18n(<AddCardDialog open onOpenChange={() => {}} accounts={ACCOUNTS} onSubmit={onSubmit} />)

    fireEvent.change(screen.getByLabelText(i18n.t('cards.cardEnding')), { target: { value: '4111111111111112' } })
    fireEvent.click(screen.getByRole('button', { name: i18n.t('cards.create') }))

    await waitFor(() => {
      expect(screen.getByText(i18n.t('cards.preview.invalidCardNumber'))).toBeTruthy()
    })
    expect(screen.getByText(i18n.t('cards.preview.invalidCardNumber')).getAttribute('data-error-code')).toBe(
      'invalid-card-number',
    )
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('whenValidCardIsSubmitted_thenPayloadCarriesOnlyIdentityColumns', () => {
  it('form.validate devolve last4/holder_name/expiry_mm_aa/theme sem PAN/CVV/is_default', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    )
    const { result } = renderHook(
      () =>
        useCardForm({
          nickname: '',
          accountId: '',
          limitCents: null,
          closingDay: 10,
          dueDay: 20,
        }),
      { wrapper },
    )
    act(() => {
      result.current.setNickname('Nu')
      result.current.setAccountId('acc-1')
      result.current.setLimitText('150,00')
      result.current.setCardNumber('4111 1111 1111 1111')
      result.current.setHolderName('joao silva')
      result.current.setExpiry('12/29')
      result.current.setCvv('123')
      result.current.setTheme('emerald')
    })

    let captured: unknown = null
    act(() => {
      captured = result.current.validate()
    })
    const input = (captured as { input: Record<string, unknown> }).input
    expect(input).toMatchObject({
      name: 'Nu',
      last4: '1111',
      holder_name: 'JOAO SILVA',
      expiry_mm_aa: '12/29',
      theme: 'emerald',
    })
    for (const forbidden of ['number', 'cvv', 'pan', 'card_number', 'is_default']) {
      expect(input).not.toHaveProperty(forbidden)
    }
    expect(JSON.stringify(input)).not.toContain('4111111111111111')
    expect(JSON.stringify(input)).not.toContain('123"')
  })
})

describe('whenCvvInputIsFocused_thenPreviewFlipsControlledByDialog', () => {
  it('foco vira o cartão, blur volta — sem estado interno no preview', async () => {
    renderWithI18n(<AddCardDialog open onOpenChange={() => {}} accounts={ACCOUNTS} onSubmit={vi.fn()} />)
    const cvv = screen.getByLabelText(i18n.t('cards.preview.cvvLabel'))
    const rotator = screen.getByTestId('card-preview-rotator')

    expect(rotator.className).toContain('rotate-y-0')
    fireEvent.focus(cvv)
    await waitFor(() => expect(rotator.className).toContain('rotate-y-180'))
    fireEvent.blur(cvv)
    await waitFor(() => expect(rotator.className).toContain('rotate-y-0'))
  })

  it('CVV nunca usa type=password e segue autocomplete cc-csc', () => {
    renderWithI18n(<AddCardDialog open onOpenChange={() => {}} accounts={ACCOUNTS} onSubmit={vi.fn()} />)
    const cvv = screen.getByLabelText(i18n.t('cards.preview.cvvLabel')) as HTMLInputElement
    expect(cvv.type).not.toBe('password')
    expect(cvv.getAttribute('autocomplete')).toBe('cc-csc')
    expect(cvv.getAttribute('inputmode')).toBe('numeric')
    expect(cvv.maxLength).toBe(4)
  })
})
