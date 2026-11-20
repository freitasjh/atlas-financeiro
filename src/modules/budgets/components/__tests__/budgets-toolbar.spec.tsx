// @vitest-environment happy-dom
// O2.1/O2.4 — TDD: toolbar <search> (busca + seletor de mês + CTA único).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { BudgetsToolbar } from '../BudgetsToolbar'

function renderToolbar(props?: Partial<React.ComponentProps<typeof BudgetsToolbar>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <BudgetsToolbar
        query=""
        onQueryChange={() => {}}
        month="2026-11-01"
        onMonthChange={() => {}}
        onNew={() => {}}
        {...props}
      />
    </I18nextProvider>,
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenBudgetsToolbarRenders_thenSearchMonthAndSingleCta', () => {
  it('busca + mês anterior/próximo + CTA único na toolbar', () => {
    renderToolbar()
    expect(screen.getByRole('searchbox', { name: i18n.t('budgets.searchLabel') })).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('budgets.prevMonth') })).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('budgets.nextMonth') })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: i18n.t('budgets.new') })).toHaveLength(1)
    expect(screen.getByRole('search').textContent).toContain(i18n.t('budgets.new'))
  })

  it('mês exibido no formato local e navegação chama onMonthChange com dia 01', async () => {
    const user = userEvent.setup()
    const onMonthChange = vi.fn()
    renderToolbar({ month: '2026-11-01', onMonthChange })
    expect(screen.getByText(/novembro|november/i)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.prevMonth') }))
    expect(onMonthChange).toHaveBeenCalledWith('2026-10-01')
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.nextMonth') }))
    expect(onMonthChange).toHaveBeenCalledWith('2026-12-01')
  })

  it('virada de ano: jan anterior volta para dez do ano anterior', async () => {
    const user = userEvent.setup()
    const onMonthChange = vi.fn()
    renderToolbar({ month: '2026-01-01', onMonthChange })
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.prevMonth') }))
    expect(onMonthChange).toHaveBeenCalledWith('2025-12-01')
  })
})
