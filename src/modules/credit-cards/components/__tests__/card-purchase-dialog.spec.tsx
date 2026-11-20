// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { DEFAULT_CARD_THEME, type CreditCardView } from '../../model/credit-card'
import { routeInvoice } from '../../model/invoice-routing'
import {
  InvoiceAlreadyPaidError,
  PurchaseInvoicePaidError,
} from '../../service/credit-cards.service'
import { CardPurchaseDialog, type CardPurchaseSubmitInput } from '../CardPurchaseDialog'

const CARD: CreditCardView = {
  id: 'c-1',
  nickname: 'Nubank Final 1234',
  brand: 'visa',
  theme: DEFAULT_CARD_THEME,
  accountId: 'acc-1',
  limitCents: 500000,
  closingDay: 15,
  dueDay: 22,
}

const CATEGORIES = [
  { id: 'cat-food', name: 'Mercado' },
  { id: 'cat-tech', name: 'Eletrônicos' },
]

interface Harness {
  onSubmit: ReturnType<typeof vi.fn>
  onOpenChange: ReturnType<typeof vi.fn>
  container: HTMLElement
}

async function renderDialog(
  overrides: Partial<{
    onSubmit: (input: CardPurchaseSubmitInput) => Promise<void>
    lng: 'pt-BR' | 'en-US'
    card: CreditCardView | null
  }> = {},
): Promise<Harness> {
  const lng = overrides.lng ?? 'pt-BR'
  await i18n.changeLanguage(lng)
  const onSubmit = vi.fn(overrides.onSubmit ?? (async () => {}))
  const onOpenChange = vi.fn()
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <CardPurchaseDialog
        open
        onOpenChange={onOpenChange}
        card={overrides.card === undefined ? CARD : overrides.card}
        categories={CATEGORIES}
        onSubmit={onSubmit}
      />
    </I18nextProvider>,
  )
  return { onSubmit, onOpenChange, container }
}

function description() {
  return screen.getByLabelText(i18n.t('cards.installmentDescription')) as HTMLInputElement
}

function amount() {
  return screen.getByLabelText(i18n.t('cards.installmentTotal')) as HTMLInputElement
}

function date() {
  return screen.getByLabelText(i18n.t('cards.purchaseDate')) as HTMLInputElement
}

function installments() {
  return screen.getByLabelText(i18n.t('cards.installmentCount')) as HTMLInputElement
}

function submit() {
  return screen.getByRole('button', { name: i18n.t('cards.installmentSubmit') })
}

function fillDefaults() {
  fireEvent.change(description(), { target: { value: 'Mercado' } })
  fireEvent.change(amount(), { target: { value: '15000' } })
  fireEvent.change(date(), { target: { value: '2026-04-14' } })
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenDialogRenders_thenFieldsAndContainmentFollowAtlas', () => {
  it('campos obrigatórios + categoria opcional e Dialog contido', async () => {
    await renderDialog()

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(i18n.t('cards.purchase.title'))).toBeTruthy()
    expect(description()).toBeTruthy()
    expect(amount()).toBeTruthy()
    expect(date()).toBeTruthy()
    expect(installments().value).toBe('1')
    expect(
      screen.getByRole('combobox', { name: i18n.t('cards.purchase.category') }).textContent,
    ).toContain(i18n.t('cards.purchase.categoryPlaceholder'))

    const content = screen.getByRole('dialog')
    expect(content.className).toContain('sm:max-w-2xl')
    expect(content.className).toContain('max-h-[92vh]')
    expect(content.className).toContain('overflow-y-auto')
    expect(content.className).toContain('overscroll-contain')
    expect(content.querySelector('form')?.className).toContain('min-w-0')
    for (const field of [description(), amount(), date(), installments()]) {
      expect(field.className).toContain('w-full')
      expect(field.className).toContain('h-1')
    }
    for (const button of screen.getAllByRole('button')) {
      if (
        button.closest('[role="dialog"]') &&
        button.getAttribute('aria-haspopup') !== 'listbox' &&
        button.getAttribute('data-slot') !== 'dialog-close'
      ) {
        expect(button.className).toContain('min-h-11')
      }
    }
  })
})

describe('whenSubmittingSinglePurchase_thenPayloadIsCentsAndCategoryNullable', () => {
  it('1x: máscara 15000 → 15000 cents, categoryId null, parcelas 1', async () => {
    const { onSubmit } = await renderDialog()
    fillDefaults()

    fireEvent.submit(submit().closest('form') as HTMLFormElement)

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith({
      description: 'Mercado',
      totalCents: 15000,
      date: '2026-04-14',
      categoryId: null,
      installments: 1,
    })
  })

  it('categoria escolhida envia o id; "Sem categoria" envia null', async () => {
    const { onSubmit } = await renderDialog()
    const user = userEvent.setup()
    fillDefaults()
    await user.click(screen.getByRole('combobox', { name: i18n.t('cards.purchase.category') }))
    await user.click(await screen.findByRole('option', { name: 'Mercado' }))

    fireEvent.submit(submit().closest('form') as HTMLFormElement)

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].categoryId).toBe('cat-food')
  })
})

describe('whenSubmittingInstallments_thenPreviewUsesPureRules', () => {
  it('3x de 100000: prévia [33334,33333,33333], soma == total e fatura via routeInvoice', async () => {
    const { onSubmit } = await renderDialog()
    fireEvent.change(description(), { target: { value: 'TV' } })
    fireEvent.change(amount(), { target: { value: '100000' } })
    fireEvent.change(date(), { target: { value: '2026-04-14' } })
    fireEvent.change(installments(), { target: { value: '3' } })

    const preview = screen.getByTestId('cards-purchase-preview')
    expect(preview).toBeTruthy()
    expect(preview.textContent).toContain('333,34')
    expect(preview.textContent).toContain('333,33')
    expect(preview.textContent).toContain(i18n.t('cards.installmentSum'))
    const cycle = routeInvoice('2026-04-14', CARD.closingDay, CARD.dueDay)
    expect(preview.textContent).toContain(cycle.period_end.slice(0, 4))

    fireEvent.submit(submit().closest('form') as HTMLFormElement)

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith({
      description: 'TV',
      totalCents: 100000,
      date: '2026-04-14',
      categoryId: null,
      installments: 3,
    })
  })

  it('limites 1 e 24 aceitos; 0 e 25 rejeitados sem submit', async () => {
    const { onSubmit } = await renderDialog()
    fillDefaults()

    fireEvent.change(installments(), { target: { value: '24' } })
    expect(installments().value).toBe('24')
    fireEvent.change(installments(), { target: { value: '0' } })
    expect(installments().value).toBe('1')
    fireEvent.change(installments(), { target: { value: '25' } })
    expect(installments().value).toBe('1')

    fireEvent.submit(submit().closest('form') as HTMLFormElement)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].installments).toBe(1)
  })
})

describe('whenValidationFails_thenFirstInvalidReceivesFocus', () => {
  it('descrição vazia: erro i18n, sem submit, foco no campo', async () => {
    const { onSubmit } = await renderDialog()
    fireEvent.change(amount(), { target: { value: '15000' } })
    fireEvent.change(date(), { target: { value: '2026-04-14' } })

    fireEvent.submit(submit().closest('form') as HTMLFormElement)

    expect(await screen.findByText(i18n.t('cards.installmentDescriptionError'))).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.activeElement?.getAttribute('name')).toBe('description')
  })

  it('valor zero e data inválida: erros i18n, sem submit', async () => {
    const { onSubmit } = await renderDialog()
    fireEvent.change(description(), { target: { value: 'Mercado' } })
    fireEvent.change(amount(), { target: { value: '0' } })
    fireEvent.change(date(), { target: { value: '' } })

    fireEvent.submit(submit().closest('form') as HTMLFormElement)

    expect(await screen.findByText(i18n.t('cards.installmentTotalError'))).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('whenTypedErrorsArrive_thenMapByIdentityNotMessage', () => {
  it('PurchaseInvoicePaidError e InvoiceAlreadyPaidError (mesma message) viram chaves distintas', async () => {
    const first = await renderDialog({
      onSubmit: async () => {
        throw new PurchaseInvoicePaidError('inv-1')
      },
    })
    fillDefaults()
    fireEvent.submit(submit().closest('form') as HTMLFormElement)
    expect(await screen.findByText(i18n.t('cards.purchase.errorPaidCycle'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('cards.purchase.errorAlreadyPaid'))).toBeNull()
    expect(new PurchaseInvoicePaidError('inv-1').message).toBe(
      new InvoiceAlreadyPaidError().message,
    )

    cleanup()
    const second = await renderDialog({
      onSubmit: async () => {
        throw new InvoiceAlreadyPaidError()
      },
    })
    fillDefaults()
    fireEvent.submit(submit().closest('form') as HTMLFormElement)
    expect(await screen.findByText(i18n.t('cards.purchase.errorAlreadyPaid'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('cards.purchase.errorPaidCycle'))).toBeNull()
    expect(first.onSubmit).toHaveBeenCalledTimes(1)
    expect(second.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('erro com name mas sem instanceof também mapeia (fallback por name)', async () => {
    await renderDialog({
      onSubmit: async () => {
        const error = new Error('category-tenant-mismatch')
        error.name = 'CategoryTenantMismatchError'
        throw error
      },
    })
    fillDefaults()
    fireEvent.submit(submit().closest('form') as HTMLFormElement)
    expect(await screen.findByText(i18n.t('cards.purchase.errorCategory'))).toBeTruthy()
  })

  it('erro desconhecido usa chave genérica sem id', async () => {
    await renderDialog({
      onSubmit: async () => {
        throw new Error('boom inv-1')
      },
    })
    fillDefaults()
    fireEvent.submit(submit().closest('form') as HTMLFormElement)
    expect(await screen.findByText(i18n.t('cards.installmentError'))).toBeTruthy()
    expect(screen.queryByText(/inv-1/)).toBeNull()
  })
})

describe('whenLocaleChanges_thenLabelsAreTranslated', () => {
  it('en-US usa rótulos em inglês', async () => {
    await renderDialog({ lng: 'en-US' })
    expect(screen.getByText('Card purchase')).toBeTruthy()
    expect(screen.getByLabelText('Description')).toBeTruthy()
    expect(screen.getByLabelText('Total ($)')).toBeTruthy()
    expect(screen.getByLabelText('Installments')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Record purchase' })).toBeTruthy()
  })
})
