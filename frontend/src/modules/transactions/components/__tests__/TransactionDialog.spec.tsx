// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'

import { TransactionDialog } from '../TransactionDialog'
import type { TransactionDialogSaveData } from '../TransactionDialog'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

function renderDialog(overrides?: {
  onSave?: (data: TransactionDialogSaveData) => void | Promise<void>
  onSubmit?: (data: TransactionDialogSaveData) => void | Promise<void>
  transactionToEdit?: any
  accounts?: any[]
  categories?: any[]
  open?: boolean
}) {
  const onSave = overrides?.onSave
  const onSubmit = overrides?.onSubmit
  const open = overrides?.open ?? true
  const accounts = overrides?.accounts ?? [{ id: 'acc-1', name: 'Conta principal' }]
  const categories = overrides?.categories
  const transactionToEdit = overrides?.transactionToEdit
  const onOpenChange = vi.fn()
  render(
    <I18nextProvider i18n={i18n}>
      <TransactionDialog
        open={open}
        onOpenChange={onOpenChange}
        onSave={onSave}
        onSubmit={onSubmit}
        transactionToEdit={transactionToEdit}
        accounts={accounts}
        categories={categories}
      />
    </I18nextProvider>,
  )
  return { onOpenChange, onSave, onSubmit }
}

describe('whenTransactionDialogOpens_thenRendersRealFields', () => {
  it('renderiza descrição, valor, tipo, data, conta, categoria e conciliado', () => {
    renderDialog()
    expect(screen.getByLabelText(/Descrição/)).toBeTruthy()
    expect(screen.getByLabelText(/Valor/)).toBeTruthy()
    expect(screen.getByLabelText(/Data/)).toBeTruthy()
    expect(screen.getByLabelText(/Conta/)).toBeTruthy()
    expect(screen.getByLabelText(/Categoria/)).toBeTruthy()
    expect(screen.getByLabelText(/Conciliado/)).toBeTruthy()
    // tabular-nums no valor
    expect((screen.getByLabelText(/Valor/) as HTMLInputElement).className).toContain('tabular-nums')
  })
})

describe('whenSubmitEmptyDescription_thenShowsErrorAndToast', () => {
  it('exibe alerta e chama toast.error uma vez', async () => {
    const user = userEvent.setup()
    renderDialog({ onSave: vi.fn() })
    await user.click(screen.getByRole('button', { name: /Cadastrar|Salvar|Criar/ }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('descrição')
    expect(toastMocks.error).toHaveBeenCalled()
  })
})

describe('whenSubmitValid_thenCallsOnSaveWithCentsAndIds', () => {
  it('envia amountCents inteiro e accountId', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderDialog({ onSave, accounts: [{ id: 'acc-1', name: 'Conta principal' }] })
    await user.type(screen.getByLabelText(/Descrição/), 'Venda X')
    await user.type(screen.getByLabelText(/Valor/), '150,00')
    await user.click(screen.getByRole('button', { name: /Cadastrar|Salvar|Criar/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const payload = onSave.mock.calls[0][0]
    expect(payload.amountCents).toBe(15000)
    expect(payload.amount_cents).toBe(15000)
    expect(payload.accountId).toBe('acc-1')
    expect(payload.account_id).toBe('acc-1')
    expect(payload.description).toBe('Venda X')
    expect(typeof payload.amountCents).toBe('number')
    expect(Number.isInteger(payload.amountCents)).toBe(true)
  })
})

describe('whenEditTransaction_thenPopulatesFields', () => {
  it('preenche descrição e valor a partir da transação', () => {
    renderDialog({
      transactionToEdit: {
        id: 't1',
        accountId: 'acc-2',
        categoryId: 'cat-1',
        date: '2026-05-10',
        amountCents: 20000,
        description: 'Edit me',
        type: 'expense',
        status: 'posted',
        reconciled: false,
      },
      accounts: [{ id: 'acc-2', name: 'Conta 2' }],
      categories: [{ id: 'cat-1', name: 'Categoria' }],
    })
    expect((screen.getByLabelText(/Descrição/) as HTMLInputElement).value).toBe('Edit me')
    expect((screen.getByLabelText(/Valor/) as HTMLInputElement).value).toBe('200,00')
  })
})

describe('whenTypeDigits_thenMaskAppliesCents', () => {
  it('digita 1500 -> exibe 15,00 e submit envia 1500 cents', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderDialog({ onSave, accounts: [{ id: 'acc-1', name: 'Conta principal' }] })
    await user.type(screen.getByLabelText(/Descrição/), 'Venda X')
    await user.type(screen.getByLabelText(/Valor/), '1500')
    expect((screen.getByLabelText(/Valor/) as HTMLInputElement).value).toBe('15,00')
    await user.click(screen.getByRole('button', { name: /Cadastrar|Salvar|Criar/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].amountCents).toBe(1500)
  })
})
