// @vitest-environment happy-dom
// O2.1/O2.3 — TDD: tabela de tetos (categoria, gasto, teto, progresso,
// status, ações; linha clicável abre edição; menu com stopPropagation).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { BudgetsTable } from '../BudgetsTable'
import type { BudgetView } from '../../model/budget.adapter'

const ROWS: BudgetView[] = [
  { id: 'b1', categoryId: 'c1', categoryName: 'Mercado', month: '2026-11-01', limitCents: 10000, spentCents: 3000, status: 'ok' },
  { id: 'b2', categoryId: 'c2', categoryName: 'Aluguel', month: '2026-11-01', limitCents: 10000, spentCents: 12000, status: 'over' },
]

function renderTable(props?: Partial<React.ComponentProps<typeof BudgetsTable>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <BudgetsTable rows={ROWS} onEdit={() => {}} onRequestDelete={() => {}} {...props} />
    </I18nextProvider>,
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenBudgetsTableRenders_thenRowsShowSpendingAndActions', () => {
  it('categorias, valores tabular-nums e barras por linha', () => {
    const { container } = renderTable()
    expect(screen.getByText('Mercado')).toBeTruthy()
    expect(screen.getByText('Aluguel')).toBeTruthy()
    // 2 progressbars + valores com tabular-nums.
    expect(screen.getAllByRole('progressbar')).toHaveLength(2)
    expect(container.querySelectorAll('.tabular-nums').length).toBeGreaterThanOrEqual(2)
    // Alerta ao estourar: texto, nunca só cor.
    expect(screen.getByText(i18n.t('budgets.band.over'))).toBeTruthy()
  })

  it('clique na linha abre edição; menu de ações isola o clique', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const onRequestDelete = vi.fn()
    renderTable({ onEdit, onRequestDelete })
    await user.click(screen.getByText('Mercado'))
    expect(onEdit).toHaveBeenCalledTimes(1)
    // Abre o menu sem disparar edição de novo.
    await user.click(screen.getByRole('button', { name: /Mercado/ }))
    expect(onEdit).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('menuitem', { name: i18n.t('budgets.edit') }))
    expect(onEdit).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('button', { name: /Aluguel/ }))
    await user.click(screen.getByRole('menuitem', { name: i18n.t('budgets.remove') }))
    expect(onRequestDelete).toHaveBeenCalledTimes(1)
  })
})
