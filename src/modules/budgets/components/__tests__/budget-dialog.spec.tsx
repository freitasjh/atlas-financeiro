// @vitest-environment happy-dom
// O2.2 — TDD: dialog Novo/Editar teto (categoria, mês, valor com máscara
// de centavos; validação + foco no 1º inválido; sm:max-w-[480px]).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { BudgetDialog } from '../BudgetDialog'

const CATEGORIES = [
  { id: 'c1', name: 'Mercado' },
  { id: 'c2', name: 'Aluguel' },
]

function renderDialog(props?: Partial<React.ComponentProps<typeof BudgetDialog>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <BudgetDialog
        open
        mode="create"
        categories={CATEGORIES}
        isSaving={false}
        serverError={null}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
        {...props}
      />
    </I18nextProvider>,
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenBudgetDialogSubmits_thenValidatesAndMasksCents', () => {
  it('envio vazio: erro de categoria e foco no 1º inválido', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderDialog({ onSubmit })
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.create') }))
    expect(await screen.findByText(i18n.t('budgets.categoryError'))).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('valor inválido: erro de teto maior que zero e sem submit', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderDialog({ onSubmit })
    await user.click(screen.getByRole('combobox', { name: `${i18n.t('budgets.category')} *` }))
    await user.click(await screen.findByRole('option', { name: 'Mercado' }))
    const amount = screen.getByLabelText(`${i18n.t('budgets.limit')} *`)
    fireEvent.change(amount, { target: { value: '0,00' } })
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.create') }))
    expect(await screen.findByText(i18n.t('budgets.limitError'))).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('válido: máscara de centavos e submit com dia 01', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderDialog({ onSubmit })
    await user.click(screen.getByRole('combobox', { name: `${i18n.t('budgets.category')} *` }))
    await user.click(await screen.findByRole('option', { name: 'Mercado' }))
    const amount = screen.getByLabelText(`${i18n.t('budgets.limit')} *`) as HTMLInputElement
    // Digita dígitos; a máscara formata em BRL (15000 -> 150,00).
    fireEvent.change(amount, { target: { value: '15000' } })
    await waitFor(() => expect(amount.value).toBe('150,00'))
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.create') }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith({
      category_id: 'c1',
      month: '2026-11-01',
      limit_cents: 15000,
    })
  })

  it('edição preenche categoria, mês e valor mascarado', async () => {
    renderDialog({
      mode: 'edit',
      initial: { categoryId: 'c2', month: '2026-11-01', limitCents: 20000 },
    })
    expect(screen.getByRole('combobox', { name: `${i18n.t('budgets.category')} *` }).textContent).toContain('Aluguel')
    expect((screen.getByLabelText(`${i18n.t('budgets.month')} *`) as HTMLInputElement).value).toBe('2026-11')
    expect((screen.getByLabelText(`${i18n.t('budgets.limit')} *`) as HTMLInputElement).value).toBe('200,00')
  })
})
