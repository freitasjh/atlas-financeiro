// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { CategoriesView } from '../CategoriesView'
import { CategoryBlockedDialog } from '../CategoryBlockedDialog'
import { CategoryDialog } from '../CategoryDialog'
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

function rowNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('tbody tr')).map(
    (tr) => tr.textContent ?? '',
  )
}

afterEach(async () => {
  cleanup()
  toastMocks.success.mockClear()
  toastMocks.error.mockClear()
  await i18n.changeLanguage('pt-BR')
})

describe('whenCategoriesViewLoads_thenLoadingAndErrorStates', () => {
  it('loading mostra skeleton com aria-busy e texto sr-only', () => {
    const { container } = renderView({ categories: [], status: 'loading' })
    const busy = container.querySelector('[aria-busy="true"]')
    expect(busy).toBeTruthy()
    expect(screen.getByText(i18n.t('categories.loading'))).toBeTruthy()
  })

  it('erro mostra role=alert e retry chama onRetry', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    renderView({ categories: [], status: 'error', error: 'boom', onRetry })
    const alerts = screen.getAllByRole('alert')
    expect(alerts.length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('boom')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: i18n.t('categories.retry') }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('whenCategoriesKpisRender_thenGlobalAndSystem', () => {
  it('KPIs ignoram filtros (sempre globais)', async () => {
    const user = userEvent.setup()
    const { container } = renderView()
    await user.click(screen.getByRole('button', { name: i18n.t('categories.incomes') }))
    // Filtrou a tabela para 2, mas o KPI total continua global (3).
    const total = container.querySelector('[data-testid="kpi-total"]')
    expect(total?.textContent).toContain('3')
    expect(screen.queryByText('Moradia')).toBeNull()
  })

  it('KPI sistema aparece quando há categoria do sistema', () => {
    renderView({
      categories: [
        ...SEED,
        { id: 's', name: 'Sistema', type: 'expense', color: null, isSystem: true, usageCount: 9 },
      ],
    })
    expect(screen.getByTestId('kpi-system').textContent).toContain('1')
  })
})

describe('whenUsageSortCycles_thenOrderAndAriaSort', () => {
  it('none -> desc -> asc com aria-sort correspondente', async () => {
    const user = userEvent.setup()
    const { container } = renderView()
    const sortButton = screen.getByRole('button', { name: i18n.t('categories.usageSort') })
    const header = screen.getByRole('columnheader', { name: i18n.t('categories.colUsage') })
    expect(header.getAttribute('aria-sort')).toBe('none')

    await user.click(sortButton)
    expect(header.getAttribute('aria-sort')).toBe('descending')
    expect(rowNames(container)[0]).toContain('Moradia')

    await user.click(sortButton)
    expect(header.getAttribute('aria-sort')).toBe('ascending')
    const asc = rowNames(container)
    expect(asc[asc.length - 1]).toContain('Moradia')
  })
})

describe('whenCategoryRowIsClicked_thenEditDialogOpens', () => {
  it('clique na linha abre edição pré-preenchida e salva patch', async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn(async () => {})
    renderView({ onRevalidateUsage: async () => 0, onUpdate })
    await user.click(screen.getByText('Salário'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: i18n.t('categories.update') })).toBeTruthy()
    const nameInput = within(dialog).getByLabelText(/nome/i) as HTMLInputElement
    expect(nameInput.value).toBe('Salário')
    await user.clear(nameInput)
    await user.type(nameInput, 'Salário Novo')
    await user.click(within(dialog).getByRole('button', { name: i18n.t('categories.update') }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    expect(onUpdate).toHaveBeenCalledWith('b', expect.objectContaining({ name: 'Salário Novo' }))
  })
})

describe('whenCategoryIsCreated_thenSingleSubmitPersists', () => {
  it('criar chama onCreate uma vez mesmo com duplo clique (sem duplo insert)', async () => {
    const user = userEvent.setup()
    let calls = 0
    const onCreate = vi.fn(async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    renderView({ onCreate })
    await user.click(screen.getByRole('button', { name: i18n.t('categories.new') }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/nome/i), 'Reserva')
    const submit = within(dialog).getByRole('button', { name: i18n.t('categories.create') })
    await user.click(submit)
    // Segundo clique enquanto salva: botão desabilitado + guarda de reentrância.
    await user.click(submit).catch(() => {})
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 3000 })
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('dialog desabilita submit enquanto salva (aria-busy)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <CategoryDialog
          open
          mode="create"
          isSaving
          serverError={null}
          onOpenChange={() => {}}
          onSubmit={async () => {}}
        />
      </I18nextProvider>,
    )
    const submit = screen.getByRole('button', { name: i18n.t('categories.create') })
    expect(submit.hasAttribute('disabled')).toBe(true)
    expect(submit.getAttribute('aria-busy')).toBe('true')
  })
})

describe('whenCategoryDeleteIsConfirmed_thenRemoveOrRaceBlock', () => {
  it('categoria livre excluída chama onRemove', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn(async () => {})
    renderView({ onRevalidateUsage: async () => 0, onRemove })
    await user.click(screen.getByRole('button', { name: i18n.t('categories.actionsOpen', { name: 'Salário' }) }))
    await user.click(screen.getByRole('menuitem', { name: i18n.t('categories.remove') }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: i18n.t('categories.deleteConfirm') }))
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith('b'))
  })

  it('corrida (in-use no confirm) abre BlockedDialog com contagem revalidada', async () => {
    const user = userEvent.setup()
    const revalidate = vi.fn(async () => 0).mockResolvedValueOnce(0).mockResolvedValueOnce(5)
    const onRemove = vi.fn(async () => {
      throw new Error('category-in-use')
    })
    renderView({ onRevalidateUsage: revalidate, onRemove })
    await user.click(screen.getByRole('button', { name: i18n.t('categories.actionsOpen', { name: 'Salário' }) }))
    await user.click(screen.getByRole('menuitem', { name: i18n.t('categories.remove') }))
    const confirm = await screen.findByRole('dialog')
    await user.click(within(confirm).getByRole('button', { name: i18n.t('categories.deleteConfirm') }))
    const blocked = await screen.findByText(i18n.t('categories.blockedTitle'))
    expect(blocked).toBeTruthy()
    expect(screen.getByText(i18n.t('categories.blockedCount', { count: 5 }))).toBeTruthy()
    expect(toastMocks.error).toHaveBeenCalledWith(i18n.t('categories.inUseError'))
  })

  it('falha na revalidação abre bloqueio honesto em vez de apagar no escuro', async () => {
    const user = userEvent.setup()
    renderView({
      onRevalidateUsage: async () => {
        throw new Error('offline')
      },
    })
    await user.click(screen.getByRole('button', { name: i18n.t('categories.actionsOpen', { name: 'Salário' }) }))
    await user.click(screen.getByRole('menuitem', { name: i18n.t('categories.remove') }))
    expect(await screen.findByText(i18n.t('categories.blockedTitle'))).toBeTruthy()
  })
})

describe('whenCategoryBlockedDialogRenders_thenHonestAndPersistent', () => {
  it('sistema mostra motivo de sistema sem link de lançamentos', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <CategoryBlockedDialog
            open
            categoryId="s"
            categoryName="Sistema"
            usageCount={9}
            isSystem
            onOpenChange={() => {}}
          />
        </MemoryRouter>
      </I18nextProvider>,
    )
    expect(screen.getByText(i18n.t('categories.blockedSystem'))).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('em uso mostra contagem tabular-nums e link com a categoria na URL', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <CategoryBlockedDialog
            open
            categoryId="abc"
            categoryName="Moradia"
            usageCount={3}
            isSystem={false}
            onOpenChange={() => {}}
          />
        </MemoryRouter>
      </I18nextProvider>,
    )
    const count = screen.getByText(i18n.t('categories.blockedCount', { count: 3 }))
    expect(count.className).toMatch(/tabular-nums/)
    const link = screen.getByRole('link', { name: i18n.t('categories.blockedViewEntries') })
    expect(link.getAttribute('href')).toContain('abc')
  })
})

describe('whenMustFixDialogContainment_thenScrollable', () => {
  it('CategoryDialog content tem contenção vertical', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <CategoryDialog
          open
          mode="create"
          isSaving={false}
          serverError={null}
          onOpenChange={() => {}}
          onSubmit={async () => {}}
        />
      </I18nextProvider>,
    )
    // Radix DialogContent renderiza em portal (document.body), não no container.
    const content = screen.getByRole('dialog')
    expect(content.className).toMatch(/max-h-\[92vh\]/)
    expect(content.className).toMatch(/overflow-y-auto/)
    expect(content.className).toMatch(/overscroll-contain/)
  })
})

describe('whenMustFixTouchTargets_thenMin44px', () => {
  it('pílulas, CTA e retry usam min-h-11 (sem h-9)', () => {
    renderView()
    const pill = screen.getByRole('button', { name: i18n.t('categories.incomes') })
    expect(pill.className).toMatch(/min-h-11/)
    expect(pill.className).not.toMatch(/(?:^|\s)h-9(?:\s|$)/)
    const cta = screen.getByRole('button', { name: i18n.t('categories.new') })
    expect(cta.className).toMatch(/min-h-11/)
    expect(cta.className).not.toMatch(/(?:^|\s)h-9(?:\s|$)/)
    // Nota: o input de busca mantém h-9 (exceção documentada — campo de
    // texto denso com 36px; regra min-h-11 cobre alvos de toque/ação).
  })

  it('retry no estado de erro usa min-h-11', () => {
    renderView({ categories: [], status: 'error', error: 'x' })
    const retry = screen.getByRole('button', { name: i18n.t('categories.retry') })
    expect(retry.className).toMatch(/min-h-11/)
  })
})
