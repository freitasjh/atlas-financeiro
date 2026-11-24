// @vitest-environment happy-dom
// B2.1 — Bugfix toolbar some quando /orcamentos está vazio:
// toolbar (busca + mês + CTA) sempre visível com 0 tetos;
// empty ocupa só área da tabela; mês navegável no vazio.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { BudgetsView } from '../BudgetsView'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

const CATEGORIES = [{ id: 'c1', name: 'Mercado' }]

function renderEmpty(props?: Partial<React.ComponentProps<typeof BudgetsView>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <BudgetsView
          budgets={[]}
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

describe('whenBudgetsEmpty_thenToolbarStaysVisible', () => {
  it('toolbar completa visível com 0 tetos (busca + mês + CTA)', () => {
    renderEmpty()
    expect(screen.getByRole('search')).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: i18n.t('budgets.searchLabel') })).toBeTruthy()
    expect(screen.getByRole('group', { name: i18n.t('budgets.monthLabel') })).toBeTruthy()
    expect(screen.getByRole('search').textContent).toContain(i18n.t('budgets.new'))
  })

  it('empty state ocupa só área da tabela (toolbar + empty coexistem)', () => {
    renderEmpty()
    expect(screen.getByTestId('budgets-empty-global')).toBeTruthy()
    expect(screen.getByText(i18n.t('budgets.emptyTitle'))).toBeTruthy()
    expect(screen.getByRole('search')).toBeTruthy()
  })

  it('CTA do empty abre dialog no vazio', async () => {
    const user = userEvent.setup()
    renderEmpty()
    const ctas = screen.getAllByRole('button', { name: i18n.t('budgets.new') })
    expect(ctas.length).toBeGreaterThanOrEqual(1)
    await user.click(ctas[ctas.length - 1])
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
  })

  it('mês navegável no vazio sem erro', async () => {
    const user = userEvent.setup()
    const onMonthChange = vi.fn()
    renderEmpty({ onMonthChange })
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.nextMonth') }))
    expect(onMonthChange).toHaveBeenCalledWith('2026-12-01')
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.prevMonth') }))
    expect(onMonthChange).toHaveBeenCalledWith('2026-10-01')
  })

  it('busca no vazio não quebra', async () => {
    const user = userEvent.setup()
    renderEmpty()
    await user.type(screen.getByRole('searchbox', { name: i18n.t('budgets.searchLabel') }), 'zzz')
    await waitFor(() => expect(screen.getByTestId('budgets-empty-global')).toBeTruthy())
  })
})
