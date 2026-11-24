// @vitest-environment happy-dom
// O2.2 — TDD: exclusão com confirmação destrutiva citando o nome.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { BudgetDeleteDialog } from '../BudgetDeleteDialog'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenBudgetDeleteConfirms_thenNameShownAndDestructive', () => {
  it('cita o nome da categoria e confirma destrutivo', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <BudgetDeleteDialog
          open
          categoryName="Mercado"
          isDeleting={false}
          error={null}
          onOpenChange={() => {}}
          onConfirm={onConfirm}
        />
      </I18nextProvider>,
    )
    expect(screen.getByText(i18n.t('budgets.removeHint', { name: 'Mercado' }))).toBeTruthy()
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.deleteConfirm') }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('erro de exclusão com role=alert', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BudgetDeleteDialog
          open
          categoryName="Mercado"
          isDeleting={false}
          error={i18n.t('budgets.saveError')}
          onOpenChange={() => {}}
          onConfirm={() => {}}
        />
      </I18nextProvider>,
    )
    const alerts = screen.getAllByRole('alert')
    expect(alerts.some((el) => el.textContent === i18n.t('budgets.saveError'))).toBe(true)
  })
})
