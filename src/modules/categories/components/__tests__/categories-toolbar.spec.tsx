// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { CategoriesToolbar } from '../CategoriesToolbar'

function renderToolbar(typeFilter: 'all' | 'income' | 'expense' = 'all', onTypeFilterChange = vi.fn()) {
  const onQueryChange = vi.fn()
  const onNew = vi.fn()
  const view = render(
    <I18nextProvider i18n={i18n}>
      <CategoriesToolbar
        query=""
        onQueryChange={onQueryChange}
        typeFilter={typeFilter}
        onTypeFilterChange={onTypeFilterChange}
        onNew={onNew}
      />
    </I18nextProvider>,
  )
  return { onQueryChange, onNew, onTypeFilterChange, ...view }
}

afterEach(() => {
  cleanup()
})

describe('whenToolbarRenders_thenSingleSegmentedContainer', () => {
  it('agrupa as 3 pílulas num único controle segmentado com ghost buttons', () => {
    renderToolbar()
    const group = screen.getByRole('group', { name: i18n.t('categories.pillsLabel') })
    expect(group.className).toMatch(/rounded-lg/)
    expect(group.className).toMatch(/bg-muted\/40/)
    expect(group.className).toMatch(/border/)
    const buttons = group.querySelectorAll('button')
    expect(buttons.length).toBe(3)
    for (const label of [i18n.t('categories.all'), i18n.t('categories.incomes'), i18n.t('categories.expenses')]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })
})

describe('whenTypeFilterChanges_thenActivePillHighlighted', () => {
  it('marca só a pílula ativa com aria-pressed=true e destaque', () => {
    renderToolbar('income')
    const active = screen.getByRole('button', { name: i18n.t('categories.incomes') })
    const inactive = screen.getByRole('button', { name: i18n.t('categories.expenses') })
    expect(active.getAttribute('aria-pressed')).toBe('true')
    expect(inactive.getAttribute('aria-pressed')).toBe('false')
    expect(active.className).toMatch(/bg-background/)
    // Alvos de toque: pílulas seguem o toggle /contas (h-11 min-h-11).
    expect(active.className).toMatch(/min-h-11/)
  })
})

describe('whenPillClicked_thenFilterHandlerFires', () => {
  it('dispara onTypeFilterChange com o filtro clicado', () => {
    const onTypeFilterChange = vi.fn()
    renderToolbar('all', onTypeFilterChange)
    fireEvent.click(screen.getByRole('button', { name: i18n.t('categories.expenses') }))
    expect(onTypeFilterChange).toHaveBeenCalledWith('expense')
  })
})

describe('whenToolbarRenders_thenCtaFollowsDensePattern', () => {
  it('CTA usa h-8 desktop com toque 44px no mobile', () => {
    renderToolbar()
    const cta = screen.getByRole('button', { name: i18n.t('categories.new') })
    expect(cta.className).toMatch(/h-8/)
    expect(cta.className).toMatch(/text-xs/)
    expect(cta.className).toMatch(/font-semibold/)
    expect(cta.className).toMatch(/max-sm:min-h-11/)
  })
})

describe('whenToolbarRenders_thenSearchIntact', () => {
  it('mantém busca e labels de a11y', () => {
    renderToolbar()
    expect(screen.getByRole('search')).toBeTruthy()
    expect(screen.getByLabelText(i18n.t('categories.searchLabel'))).toBeTruthy()
  })
})
