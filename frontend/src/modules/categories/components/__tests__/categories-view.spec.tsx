// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { CategoriesView } from '../CategoriesView'
import type { CategoryView } from '../../model/category.adapter'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

const SEED: CategoryView[] = [
  { id: 'a', name: 'Moradia', type: 'expense', color: '#f43f5e', isSystem: false, usageCount: 3 },
  { id: 'b', name: 'Salário', type: 'income', color: '#10b981', isSystem: false, usageCount: 0 },
  { id: 'c', name: 'Freela', type: 'income', color: null, isSystem: false, usageCount: 0 },
]

function renderView(props?: Partial<React.ComponentProps<typeof CategoriesView>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <CategoriesView
          categories={SEED}
          status="ready"
          error={null}
          onRetry={() => {}}
          onCreate={async () => {}}
          onUpdate={async () => {}}
          onRemove={async () => {}}
          onRevalidateUsage={async () => 0}
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

describe('whenCategoriesViewRenders_thenHeaderKpisToolbarTableFooter', () => {
  it('header sem CTA + 3 KPIs globais com tabular-nums e sem KPI sistema', () => {
    const { container } = renderView()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(i18n.t('categories.title'))
    expect(screen.queryByText(i18n.t('categories.kpiSystem'))).toBeNull()
    // 3 KPIs + 3 contagens da tabela com tabular-nums.
    expect(container.querySelectorAll('.tabular-nums').length).toBeGreaterThanOrEqual(6)
  })

  it('CTA único vive só na toolbar (Regra da Ação Única)', () => {
    renderView()
    expect(screen.getAllByRole('button', { name: i18n.t('categories.new') })).toHaveLength(1)
    expect(screen.getByRole('search').textContent).toContain(i18n.t('categories.new'))
  })

  it('rodapé conta Mostrando X de Y', () => {
    renderView()
    expect(screen.getByText(i18n.t('categories.footerShowing', { shown: 3, total: 3 }))).toBeTruthy()
  })

  it('coluna Em uso ordenável com aria-sort', () => {
    renderView()
    const usageHeader = screen.getByRole('columnheader', { name: i18n.t('categories.colUsage') })
    expect(usageHeader.getAttribute('aria-sort')).toBe('none')
  })
})

describe('whenCategoryFiltersChange_thenSearchAndPillsComposeWithAnd', () => {
  it('pílulas têm aria-pressed e filtram por tipo', async () => {
    const user = userEvent.setup()
    renderView()
    const incomePill = screen.getByRole('button', { name: i18n.t('categories.incomes') })
    expect(incomePill.getAttribute('aria-pressed')).toBe('false')
    await user.click(incomePill)
    expect(screen.queryByText('Moradia')).toBeNull()
    expect(screen.getByText('Salário')).toBeTruthy()
    expect(screen.getByText('Freela')).toBeTruthy()
  })

  it('busca com debounce filtra por nome e compõe AND com a pílula', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(screen.getByRole('button', { name: i18n.t('categories.incomes') }))
    await user.type(screen.getByRole('searchbox', { name: i18n.t('categories.searchLabel') }), 'sal')
    await waitFor(() => expect(screen.queryByText('Freela')).toBeNull(), { timeout: 2000 })
    expect(screen.getByText('Salário')).toBeTruthy()
  })

  it('filtro sem resultado cita o termo e oferece Limpar', async () => {
    const user = userEvent.setup()
    renderView()
    await user.type(screen.getByRole('searchbox', { name: i18n.t('categories.searchLabel') }), 'zzz')
    expect(await screen.findByText(i18n.t('categories.noResults', { query: 'zzz' }), {}, { timeout: 2000 })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: i18n.t('categories.clearFilters') }))
    expect(screen.getByText('Moradia')).toBeTruthy()
  })

  it('lista vazia global mostra CTA com o mesmo handler', async () => {
    const user = userEvent.setup()
    renderView({ categories: [] })
    expect(screen.getByText(i18n.t('categories.emptyTitle'))).toBeTruthy()
    await user.click(screen.getByRole('button', { name: i18n.t('categories.new') }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('whenCategoryDeleteIsRequested_thenBlockedOrConfirm', () => {
  it('categoria em uso abre BlockedDialog âmbar persistente (nunca toast-only)', async () => {
    const user = userEvent.setup()
    renderView({ onRevalidateUsage: async () => 3 })
    await user.click(screen.getByRole('button', { name: i18n.t('categories.actionsOpen', { name: 'Moradia' }) }))
    await user.click(screen.getByRole('menuitem', { name: i18n.t('categories.remove') }))
    const blocked = await screen.findByRole('dialog')
    expect(blocked.innerHTML).toContain('amber')
    const counts = within(blocked).getByText(i18n.t('categories.blockedCount', { count: 3 }))
    expect(counts.className).toMatch(/tabular-nums/)
    expect(
      screen.getByRole('link', { name: i18n.t('categories.blockedViewEntries') }),
    ).toBeTruthy()
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('categoria livre abre confirm destrutivo citando o nome', async () => {
    const user = userEvent.setup()
    renderView({ onRevalidateUsage: async () => 0 })
    await user.click(screen.getByRole('button', { name: i18n.t('categories.actionsOpen', { name: 'Salário' }) }))
    await user.click(screen.getByRole('menuitem', { name: i18n.t('categories.remove') }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('Salário')
  })
})

describe('whenCategoryIsSystem_thenRowIsReadOnly', () => {
  it('linha seed exibe badge Lock e sem ações', () => {
    renderView({
      categories: [
        { id: 's', name: 'Sistema', type: 'expense', color: null, isSystem: true, usageCount: 9 },
      ],
    })
    expect(
      screen.getByText(i18n.t('categories.systemBadge'), { selector: '[data-slot="badge"]' }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /ações/i })).toBeNull()
  })
})
