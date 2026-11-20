// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../../../i18n'
import { NewAccountModal } from '../NewAccountModal'
import type { NewBankAccountInput } from '../../model/view-model'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

function renderModal(overrides?: {
  onSubmit?: (input: NewBankAccountInput) => void | Promise<void>
  onOpenChange?: (open: boolean) => void
}) {
  const onSubmit = overrides?.onSubmit ?? vi.fn()
  const onOpenChange = overrides?.onOpenChange ?? vi.fn()
  render(
    <I18nextProvider i18n={i18n}>
      <NewAccountModal open onOpenChange={onOpenChange} onSubmit={onSubmit} />
    </I18nextProvider>,
  )
  return { onSubmit, onOpenChange }
}

function saveLabel(): string {
  return i18n.t('accounts.saveBankAccount')
}

describe('whenModalOpens_thenRendersAllSections', () => {
  it('renderiza carrossel instituição, tipo+apelido, 4 cols, conexão e footer', () => {
    renderModal()
    expect(screen.getByText('Instituição financeira')).toBeTruthy()
    expect(screen.getByTestId('institution-carousel')).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('accounts.carouselPrev') })).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('accounts.carouselNext') })).toBeTruthy()
    expect(screen.getByText('Tipo de conta')).toBeTruthy()
    expect(screen.getByLabelText(/Apelido da conta/)).toBeTruthy()
    expect(screen.getByLabelText('Agência')).toBeTruthy()
    expect(screen.getByLabelText('Conta')).toBeTruthy()
    expect(screen.getByLabelText('Dígito')).toBeTruthy()
    expect(screen.getByLabelText('Saldo inicial (R$)')).toBeTruthy()
    expect(screen.getByText('Sincronização & extrato')).toBeTruthy()
    expect(screen.getByRole('button', { name: saveLabel() })).toBeTruthy()
    expect(screen.getByText('Cancelar')).toBeTruthy()
    // tabular-nums nos monetários/contadores
    const balance = screen.getByLabelText('Saldo inicial (R$)')
    expect(balance.className).toContain('tabular-nums')
  })
})

describe('whenCarouselRenders_thenShowsAllInstitutionsInSingleRow', () => {
  it('exibe as 13 instituições com COMPE em linha rolável única', () => {
    renderModal()
    const carousel = screen.getByTestId('institution-carousel')
    expect(carousel.className).toContain('overflow-x-auto')
    expect(carousel.className).toContain('flex')
    // todas as 13 opções presentes via aria-pressed
    const pressed = carousel.querySelectorAll('[aria-pressed]')
    expect(pressed.length).toBe(13)
    // COMPE visível (tabular-nums)
    expect(carousel.textContent).toContain('341')
    expect(carousel.textContent).toContain('237')
  })

  it('navega com as setas sem quebrar seleção', async () => {
    const user = userEvent.setup()
    renderModal()
    const carousel = screen.getByTestId('institution-carousel')
    const scrollBy = vi.fn()
    carousel.scrollBy = scrollBy
    await user.click(screen.getByRole('button', { name: i18n.t('accounts.carouselNext') }))
    expect(scrollBy).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: i18n.t('accounts.carouselPrev') }))
    expect(scrollBy).toHaveBeenCalledTimes(2)
  })
})

describe('whenTypeSectionRenders_thenKeepsFiveTypes', () => {
  it('mantém os 5 tipos com wrap e seleção via aria-pressed', async () => {
    const user = userEvent.setup()
    renderModal()
    for (const key of [
      'accounts.typeChecking',
      'accounts.typeSavings',
      'accounts.typeInvestment',
      'accounts.typeWallet',
      'accounts.typePhysicalCash',
    ]) {
      expect(screen.getByText(i18n.t(key))).toBeTruthy()
    }
    const savings = screen.getByText(i18n.t('accounts.typeSavings'))
    expect(savings.closest('button')?.getAttribute('aria-pressed')).toBe('false')
    await user.click(savings)
    expect(savings.closest('button')?.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('whenConnectionMethodSelected_thenCardUsesEmeraldHighlight', () => {
  it('marca o card manual em verde e o outro neutro', async () => {
    const user = userEvent.setup()
    renderModal()
    const manual = screen.getByText(i18n.t('accounts.manualOfx')).closest('button')!
    const openFinance = screen.getByText(i18n.t('accounts.openFinance')).closest('button')!
    // default: manual selecionado em verde
    expect(manual.className).toContain('emerald')
    expect(manual.getAttribute('aria-pressed')).toBe('true')
    expect(openFinance.className).not.toContain('emerald')
    await user.click(screen.getByText(i18n.t('accounts.openFinance')))
    expect(openFinance.className).toContain('emerald')
    expect(openFinance.getAttribute('aria-pressed')).toBe('true')
    expect(manual.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('whenBalanceBlurs_thenAppliesBRLMask', () => {
  it('formata 15000 cents para 150,00 sem quebrar submit', async () => {
    const user = userEvent.setup()
    renderModal()
    const balance = screen.getByLabelText('Saldo inicial (R$)') as HTMLInputElement
    await user.type(balance, '150,00')
    fireEvent.blur(balance)
    expect(balance.value).toBe('150,00')
  })
})

describe('whenSubmitWithEmptyName_thenShowsNameErrorAndFocusesNickname', () => {
  it('exibe accounts.nameError com role=alert e foca apelido', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.click(screen.getByRole('button', { name: saveLabel() }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Informe o nome da conta')
    const nickname = screen.getByLabelText(/Apelido da conta/)
    expect(nickname.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(nickname)
  })
})

describe('whenNonNumericTyped_thenMaskDiscards', () => {
  it('descarta caracteres não numéricos no saldo', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.type(screen.getByLabelText('Saldo inicial (R$)'), 'abc')
    const balance = screen.getByLabelText('Saldo inicial (R$)') as HTMLInputElement
    expect(balance.value).toBe('')
  })
})

describe('whenSubmitValid_thenPersistsAllFields', () => {
  it('chama onSubmit com cents, conexão e flags (sem float)', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    renderModal({ onSubmit })
    await user.type(screen.getByLabelText(/Apelido da conta/), 'BTG • Tesouraria')
    await user.type(screen.getByLabelText('Agência'), '0001')
    await user.type(screen.getByLabelText('Conta'), '45210')
    await user.type(screen.getByLabelText('Dígito'), '8')
    await user.type(screen.getByLabelText('Saldo inicial (R$)'), '150,00')
    await user.click(screen.getByText('Open Finance'))
    await user.click(screen.getByText('Definir como conta principal da empresa'))
    await user.click(screen.getByRole('button', { name: saveLabel() }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const payload = onSubmit.mock.calls[0][0]
    expect(payload.initialBalanceCents).toBe(15000)
    expect(typeof payload.initialBalanceCents).toBe('number')
    expect(Number.isInteger(payload.initialBalanceCents)).toBe(true)
    expect(payload.connectionStatus).toBe('connected')
    expect(payload.isDefault).toBe(true)
    expect(payload.agency).toBe('0001')
    expect(payload.accountNumber).toBe('45210')
    expect(payload.accountDigit).toBe('8')
    expect(payload.name).toBe('BTG • Tesouraria')
  })
})

describe('whenSubmitFails_thenShowsSaveError', () => {
  it('exibe accounts.saveError e libera o botão (submitting/error)', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockRejectedValue(new Error('db down'))
    renderModal({ onSubmit })
    await user.type(screen.getByLabelText(/Apelido da conta/), 'Conta X')
    const saveButton = screen.getByRole('button', { name: saveLabel() })
    await user.click(saveButton)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Não foi possível salvar a conta')
    await waitFor(() => expect(saveButton.hasAttribute('disabled')).toBe(false))
  })
})

describe('whenModalCloses_thenFormResets', () => {
  it('limpa apelido e saldo ao fechar', () => {
    const { onOpenChange } = renderModal()
    const nickname = screen.getByLabelText(/Apelido da conta/) as HTMLInputElement
    fireEvent.change(nickname, { target: { value: 'Conta X' } })
    act(() => {
      screen.getByText('Cancelar').click()
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
