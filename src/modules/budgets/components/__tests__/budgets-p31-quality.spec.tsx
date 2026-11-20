// @vitest-environment happy-dom
// P3.1 — TDD qualidade: guarda limit<=0, linha com teclado, select travado
// em edit, submit de edição, idempotência anti-duplo.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { budgetStatus, type BudgetView } from '../../model/budget.adapter'
import { BudgetsTable } from '../BudgetsTable'
import { BudgetDialog } from '../BudgetDialog'
import { BudgetsView } from '../BudgetsView'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

const CATEGORIES = [
  { id: 'c1', name: 'Mercado' },
  { id: 'c2', name: 'Aluguel' },
]

const SEED: BudgetView[] = [
  { id: 'b1', categoryId: 'c1', categoryName: 'Mercado', month: '2026-11-01', limitCents: 100000, spentCents: 30000, status: 'ok' },
]

function renderView(props?: Partial<React.ComponentProps<typeof BudgetsView>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <BudgetsView
          budgets={SEED}
          status="ready"
          error={null}
          month="2026-11-01"
          onMonthChange={() => {}}
          categories={CATEGORIES}
          onRetry={() => {}}
          onCreate={async () => {}}
          onUpdate={async () => {}}
          onRemove={async () => {}}
          {...props}
        />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenLimitIsNotPositive_thenNoGhostWarning', () => {
  it('0/0 não gera warning fantasma (guarda display)', () => {
    expect(budgetStatus(0, 0)).toBe('ok')
  })

  it('gasto sem teto válido não vira over fantasma', () => {
    expect(budgetStatus(5000, 0)).toBe('ok')
    expect(budgetStatus(5000, -100)).toBe('ok')
  })
})

describe('whenBudgetRowIsFocused_thenKeyboardOpensEdit', () => {
  it('linha focável (tabIndex) + Enter abre edição', () => {
    const onEdit = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <BudgetsTable rows={SEED} onEdit={onEdit} onRequestDelete={() => {}} />
      </I18nextProvider>,
    )
    const row = screen.getByRole('row', { name: /Mercado/ })
    expect(row.getAttribute('tabindex')).toBe('0')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('Espaço também abre edição', () => {
    const onEdit = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <BudgetsTable rows={SEED} onEdit={onEdit} onRequestDelete={() => {}} />
      </I18nextProvider>,
    )
    fireEvent.keyDown(screen.getByRole('row', { name: /Mercado/ }), { key: ' ' })
    expect(onEdit).toHaveBeenCalledTimes(1)
  })
})

describe('whenBudgetDialogIsEdit_thenCategoryIsLocked', () => {
  it('select de categoria disabled + hint sem literal', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BudgetDialog
          open
          mode="edit"
          initial={{ categoryId: 'c1', month: '2026-11-01', limitCents: 20000 }}
          categories={CATEGORIES}
          isSaving={false}
          serverError={null}
          onOpenChange={() => {}}
          onSubmit={async () => {}}
        />
      </I18nextProvider>,
    )
    expect(
      (screen.getByRole('combobox', { name: `${i18n.t('budgets.category')} *` }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByText(i18n.t('budgets.categoryLocked'))).toBeTruthy()
  })

  it('modo create mantém select habilitado', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BudgetDialog
          open
          mode="create"
          categories={CATEGORIES}
          isSaving={false}
          serverError={null}
          onOpenChange={() => {}}
          onSubmit={async () => {}}
        />
      </I18nextProvider>,
    )
    expect(
      (screen.getByRole('combobox', { name: `${i18n.t('budgets.category')} *` }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })
})

describe('whenBudgetEditSubmits_thenPatchWithoutCategory', () => {
  it('editar teto chama onUpdate com month + limit_cents (sem categoria)', async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    renderView({ onUpdate })
    await user.click(screen.getByText('Mercado'))
    const amount = screen.getByLabelText(`${i18n.t('budgets.limit')} *`)
    fireEvent.change(amount, { target: { value: '20000' } })
    await user.click(screen.getByRole('button', { name: i18n.t('common.save') }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    expect(onUpdate).toHaveBeenCalledWith('b1', { month: '2026-11-01', limit_cents: 20000 })
  })
})

describe('whenBudgetSubmitRaces_thenSingleInsert', () => {
  it('duplo submit rápido gera um único create (anti-duplo)', async () => {
    const user = userEvent.setup()
    let resolveCreate!: () => void
    const onCreate = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveCreate = resolve }),
    )
    renderView({ onCreate })
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.new') }))
    await user.click(screen.getByRole('combobox', { name: `${i18n.t('budgets.category')} *` }))
    await user.click(await screen.findByRole('option', { name: 'Mercado' }))
    fireEvent.change(screen.getByLabelText(`${i18n.t('budgets.limit')} *`), { target: { value: '1000' } })
    const submit = screen.getByRole('button', { name: i18n.t('budgets.create') })
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    resolveCreate()
  })
})
