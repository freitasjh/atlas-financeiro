// @vitest-environment happy-dom
// O2.3 — TDD: barra gasto-vs-teto (h-2, cor+ícone+texto por status,
// tabular-nums) + alerta ao estourar (badge + texto, nunca só cor).

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { BudgetProgress } from '../BudgetProgress'

function renderBar(spentCents: number, limitCents: number) {
  return render(
    <I18nextProvider i18n={i18n}>
      <BudgetProgress spentCents={spentCents} limitCents={limitCents} />
    </I18nextProvider>,
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenBudgetProgressRenders_thenBarReflectsStatus', () => {
  it('ok: barra h-2 com progressbar, percentual tabular-nums e texto de status', () => {
    const { container } = renderBar(3000, 10000)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('30')
    expect(container.querySelector('.h-2.rounded-full')).toBeTruthy()
    expect(container.querySelectorAll('.tabular-nums').length).toBeGreaterThanOrEqual(1)
    // Status por texto, nunca só cor.
    expect(screen.getByText(i18n.t('budgets.band.ok'))).toBeTruthy()
  })

  it('warning aos 80%: badge + texto de atenção', () => {
    renderBar(8000, 10000)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('80')
    expect(screen.getByText(i18n.t('budgets.band.warn'))).toBeTruthy()
  })

  it('over: alerta com badge + texto (role=alert ou status textual), barra cheia', () => {
    renderBar(12000, 10000)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
    expect(screen.getByText(i18n.t('budgets.band.over'))).toBeTruthy()
    // Gasto e teto visíveis em tabular-nums.
    const text = document.body.textContent ?? ''
    expect(text).toContain('120,00')
    expect(text).toContain('100,00')
  })
})
