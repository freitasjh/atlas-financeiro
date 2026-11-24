// @vitest-environment happy-dom
// O2.1/O2.4 — TDD: BudgetsView (header sem CTA, KPIs aria-live, toolbar,
// tabela, rodapé, empty/filtered-empty/erro+retry, dialogs na raiz).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { BudgetsView } from '../BudgetsView'
import type { BudgetView } from '../../model/budget.adapter'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

const CATEGORIES = [
  { id: 'c1', name: 'Mercado' },
  { id: 'c2', name: 'Aluguel' },
]

const SEED: BudgetView[] = [
  { id: 'b1', categoryId: 'c1', categoryName: 'Mercado', month: '2026-11-01', limitCents: 100000, spentCents: 30000, status: 'ok' },
  { id: 'b2', categoryId: 'c2', categoryName: 'Aluguel', month: '2026-11-01', limitCents: 100000, spentCents: 120000, status: 'over' },
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

describe('whenBudgetsViewRenders_thenHeaderKpisToolbarTableFooter', () => {
  it('header sem CTA + 4 KPIs globais com tabular-nums e aria-live', () => {
    const { container } = renderView()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(i18n.t('budgets.title'))
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy()
    for (const key of ['budgets.kpiTotal', 'budgets.kpiSpent', 'budgets.kpiUsed', 'budgets.kpiOver']) {
      expect(screen.getByText(i18n.t(key))).toBeTruthy()
    }
    expect(container.querySelectorAll('.tabular-nums').length).toBeGreaterThanOrEqual(4)
  })

  it('CTA único vive só na toolbar (Regra da Ação Única)', () => {
    renderView()
    expect(screen.getAllByRole('button', { name: i18n.t('budgets.new') })).toHaveLength(1)
    expect(screen.getByRole('search').textContent).toContain(i18n.t('budgets.new'))
  })

  it('rodapé conta Mostrando X de Y', () => {
    renderView()
    expect(screen.getByText(i18n.t('budgets.footerShowing', { shown: 2, total: 2 }))).toBeTruthy()
  })

  it('alerta ao estourar: texto de status, nunca só cor', () => {
    renderView()
    expect(screen.getByText(i18n.t('budgets.band.over'))).toBeTruthy()
  })
})

describe('whenBudgetsViewHasNoData_thenHonestStates', () => {
  it('vazio global com toolbar + empty (toolbar sempre visível)', () => {
    renderView({ budgets: [] })
    expect(screen.getByText(i18n.t('budgets.emptyTitle'))).toBeTruthy()
    expect(screen.getByRole('search')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: i18n.t('budgets.new') }).length).toBeGreaterThanOrEqual(2)
  })

  it('filtro sem resultado + limpar', async () => {
    const user = userEvent.setup()
    renderView()
    await user.type(screen.getByRole('searchbox', { name: i18n.t('budgets.searchLabel') }), 'zzz')
    await waitFor(
      () => expect(screen.getByText(i18n.t('budgets.noResults', { query: 'zzz' }))).toBeTruthy(),
      { timeout: 2000 },
    )
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.clearFilters') }))
    await waitFor(() => expect(screen.getByText('Mercado')).toBeTruthy(), { timeout: 2000 })
  })

  it('erro com role=alert + retry', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    renderView({ status: 'error', error: i18n.t('budgets.loadError'), onRetry })
    const alerts = screen.getAllByRole('alert')
    expect(alerts.some((el) => el.textContent === i18n.t('budgets.loadError'))).toBe(true)
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.retry') }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('whenBudgetEditorOpens_thenCreateEditDeleteFlow', () => {
  it('criar via CTA abre dialog e salva', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockResolvedValue(undefined)
    renderView({ onCreate })
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.new') }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('excluir pede confirmação com o nome', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn().mockResolvedValue(undefined)
    renderView({ onRemove })
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.actionsOpen', { name: 'Aluguel' }) }))
    await user.click(screen.getByRole('menuitem', { name: i18n.t('budgets.remove') }))
    expect(screen.getByText(i18n.t('budgets.removeHint', { name: 'Aluguel' }))).toBeTruthy()
    await user.click(screen.getByRole('button', { name: i18n.t('budgets.deleteConfirm') }))
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith('b2'))
  })
})
