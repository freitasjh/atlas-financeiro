// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { formatCentsBRL } from '@/lib/utils'
import { CardExpensesTable, type ExpenseRow } from '@/components/shadcn/credit-card/card-expenses-table'
import type { ExpenseFilter } from '../../hooks/useCreditCards'

afterEach(() => {
  cleanup()
})

function expense(id: string, overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id,
    description: `Compra ${id}`,
    date: '2026-09-15',
    amountCents: 10000,
    installmentLabel: null,
    categoryName: null,
    pending: false,
    isTransfer: false,
    ...overrides,
  }
}

const EXPENSES: ExpenseRow[] = [
  expense('e-1'),
  expense('e-2', { date: '2026-09-20', installmentLabel: '2/3', pending: true }),
  expense('e-3', { date: '2026-09-21', isTransfer: true }),
]

interface Harness {
  onFilterChange: ReturnType<typeof vi.fn>
  onSearchChange: ReturnType<typeof vi.fn>
  onExport: ReturnType<typeof vi.fn>
  onOpenDetail: ReturnType<typeof vi.fn>
  onNewPurchase: ReturnType<typeof vi.fn>
  container: HTMLElement
}

async function renderTable(
  overrides: Partial<{
    expenses: ExpenseRow[]
    filter: ExpenseFilter
    search: string
  }> = {},
  lng: 'pt-BR' | 'en-US' = 'pt-BR',
): Promise<Harness> {
  await i18n.changeLanguage(lng)
  const onFilterChange = vi.fn()
  const onSearchChange = vi.fn()
  const onExport = vi.fn()
  const onOpenDetail = vi.fn()
  const onNewPurchase = vi.fn()
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <CardExpensesTable
        expenses={overrides.expenses ?? EXPENSES}
        filter={overrides.filter ?? 'all'}
        search={overrides.search ?? ''}
        onFilterChange={onFilterChange}
        onSearchChange={onSearchChange}
        onExport={onExport}
        onOpenDetail={onOpenDetail}
        onNewPurchase={onNewPurchase}
      />
    </I18nextProvider>,
  )
  return { onFilterChange, onSearchChange, onExport, onOpenDetail, onNewPurchase, container }
}

describe('whenRenderizaTabelaDeDespesas_thenSegueDataTableDoBankAccount', () => {
  it('whenRenderiza_thenContainerTemBordaArredondadaEShadow', async () => {
    const { container } = await renderTable()

    const outer = container.firstElementChild as HTMLElement
    expect(outer.className).toContain('rounded-2xl')
    expect(outer.className).toContain('border-border/80')
    expect(outer.className).toContain('bg-card')
    expect(outer.className).toContain('shadow-xs')
    expect(outer.className).toContain('overflow-hidden')
    expect(outer.className).toContain('min-w-0')
  })

  it('whenRenderiza_thenHeaderTemTituloSubtituloEExportForaDaBusca', async () => {
    const { container } = await renderTable()

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      i18n.t('cards.transactions.title'),
    )
    expect(screen.getByText(i18n.t('cards.transactions.searchPlaceholder'))).toBeTruthy()

    const search = container.querySelector('search')
    expect(search).not.toBeNull()
    expect(search?.getAttribute('aria-label')).toBe(i18n.t('cards.table.searchLabel'))
    expect(search?.className).toContain('border-b')
    expect(search?.className).toContain('p-4')
    expect(search?.className).toContain('lg:flex-row')

    const exportButton = screen.getByRole('button', {
      name: i18n.t('cards.table.export'),
    })
    expect(search?.contains(exportButton)).toBe(false)
    expect(exportButton.className).toContain('min-h-11')
  })

  it('whenRenderiza_thenBuscaTemLabelSrOnlyEClassePl9', async () => {
    const { container } = await renderTable()

    const input = screen.getByRole('searchbox', {
      name: i18n.t('cards.table.searchLabel'),
    })
    expect(input.getAttribute('type')).toBe('search')
    expect(input.getAttribute('placeholder')).toBe(
      i18n.t('cards.transactions.searchPlaceholder'),
    )
    expect(input.className).toContain('pl-9')
    expect(input.className).toContain('h-10')
    expect(input.className).toContain('sm:h-9')
    expect(input.className).toContain('bg-background')

    const label = container.querySelector('search label.sr-only')
    expect(label).not.toBeNull()
    expect(label?.textContent).toBe(i18n.t('cards.table.searchLabel'))
  })

  it('whenRenderiza_thenFiltrosSaoUmUnicoPillToggleControladoNoTamanhoSm', async () => {
    const { container } = await renderTable()

    const groups = container.querySelectorAll('[role="radiogroup"]')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.getAttribute('aria-label')).toBe(i18n.t('cards.transactions.title'))

    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(radios.map((radio) => radio.textContent)).toEqual([
      i18n.t('cards.table.all'),
      i18n.t('cards.table.pending'),
      i18n.t('cards.table.installments'),
    ])
    radios.forEach((radio) => {
      // Valida que o filtro está no tamanho sm
      expect(radio.className).toContain('h-6')
      expect(radio.className).toContain('focus-visible:ring-2')
    })
    expect(container.querySelector('button[aria-pressed]')).toBeNull()
  })

  it('whenRenderiza_thenMantemApenasColunasDoDominioDoCartao', async () => {
    const { container } = await renderTable()

    expect(screen.getByRole('columnheader', { name: i18n.t('cards.installmentDescription') })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: i18n.t('cards.purchaseDate') })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: i18n.t('cards.detail.amount') })).toBeTruthy()
    expect(screen.queryByText('Contraparte')).toBeNull()
    expect(screen.queryByText('Documento')).toBeNull()
    expect(screen.queryByText('Status de conciliação')).toBeNull()

    expect(screen.getAllByText(i18n.t('cards.transactions.invoicePayment')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('2/3').length).toBeGreaterThan(0)
    expect(screen.getAllByText('15/09').length).toBeGreaterThan(0)

    const moneyCells = Array.from(container.querySelectorAll('td')).filter((cell) =>
      cell.className.includes('text-right'),
    )
    expect(moneyCells).toHaveLength(3)
    const expected = formatCentsBRL(10000).replace(/\s/g, ' ')
    expect(moneyCells.map((cell) => cell.textContent?.replace(/\s/g, ' '))).toEqual([
      `+ ${expected}`,
      expected,
      expected,
    ])
    moneyCells.forEach((cell) => {
      expect(cell.querySelector('span')?.className).toContain('font-mono')
      expect(cell.querySelector('span')?.className).toContain('tabular-nums')
    })
  })

  it('whenClicaLinha_thenAbreDetalheDoLancamento', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = await renderTable()

    await user.click(screen.getByText('Compra e-2'))

    expect(onOpenDetail).toHaveBeenCalledTimes(1)
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'e-2',
        description: 'Compra e-2',
      }),
    )
  })

  it('whenSelecionaFiltro_thenPropagaParaPropSemEstadoLocal', async () => {
    const user = userEvent.setup()
    const { onFilterChange, onOpenDetail } = await renderTable()

    await user.click(screen.getByRole('radio', { name: i18n.t('cards.table.pending') }))

    expect(onFilterChange).toHaveBeenCalledWith('pending')
    expect(onOpenDetail).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: i18n.t('cards.table.all') }).getAttribute('aria-checked')).toBe('true')
  })

  it('whenDigitaBusca_thenPropagaParaPropSemEstadoLocal', async () => {
    const { onSearchChange, container } = await renderTable()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'mercado' } })

    expect(onSearchChange).toHaveBeenCalledTimes(1)
    expect(onSearchChange).toHaveBeenCalledWith('mercado')
    const cellText = Array.from(container.querySelectorAll('td')).map((cell) => cell.textContent)
    expect(cellText.some((text) => text?.includes('Compra e-2'))).toBe(true)
  })

  it('whenRenderiza_thenRodapeMostraContadorEHint', async () => {
    await renderTable()

    expect(
      screen.getByText(i18n.t('cards.table.footer', { shown: 3, total: 3 })),
    ).toBeTruthy()
    expect(screen.getByText(new RegExp(i18n.t('cards.table.detailHint')))).toBeTruthy()
  })

  it('whenFiltraEJaHaFiltroAplicado_thenMantemLinhasFiltradasPelasProps', async () => {
    const { container } = await renderTable({ filter: 'pending' })

    expect(screen.getByText('Compra e-2')).toBeTruthy()
    expect(screen.queryByText('Compra e-1')).toBeNull()
    expect(screen.getByRole('radio', { name: i18n.t('cards.table.pending') }).getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('td')?.textContent).toContain('Compra e-2')
  })

  it('whenNaoHaResultados_thenMostraMensagemSemLinhas', async () => {
    await renderTable({ search: 'inexistente' })

    expect(screen.getByText(i18n.t('cards.transactions.noResults'))).toBeTruthy()
    expect(screen.queryByRole('cell')).toBeNull()
  })

  it('whenRenderizaEmIngles_thenUsaRotulosTraduzidos', async () => {
    await renderTable({}, 'en-US')

    expect(screen.getByRole('radio', { name: 'Installments' })).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: 'Search invoice expenses' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy()
  })
})

describe('whenExpenseHasCategory_thenSublineShowsName', () => {
  it('categoria presente → badge com nome; ausente → Sem categoria', async () => {
    await renderTable({
      expenses: [
        expense('e-cat', { categoryName: 'Alimentação' }),
        expense('e-no', { categoryName: null }),
      ],
    })

    expect(screen.getAllByText('Alimentação').length).toBeGreaterThan(0)
    expect(screen.getAllByText(i18n.t('cards.purchase.noCategory')).length).toBeGreaterThan(0)
  })

  it('parcela com categoria mostra dados correspondentes', async () => {
    await renderTable({
      expenses: [expense('e-parc', { installmentLabel: '3/10', categoryName: 'Alimentação' })],
    })

    expect(screen.getAllByText('3/10').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Alimentação').length).toBeGreaterThan(0)
  })

  it('transferência mantém badge de pagamento', async () => {
    await renderTable({
      expenses: [expense('e-tx', { isTransfer: true, categoryName: 'Alimentação' })],
    })

    expect(screen.getAllByText(i18n.t('cards.transactions.invoicePayment')).length).toBeGreaterThan(0)
  })
})

describe('whenNovaCompraTrigger_thenSingleActionBesideExport', () => {
  it('gatilho único no header, fora da busca, ao lado de Exportar', async () => {
    const { container, onNewPurchase } = await renderTable()

    const buttons = screen.getAllByRole('button', { name: i18n.t('cards.transactions.newPurchase') })
    expect(buttons).toHaveLength(1)
    expect(buttons[0].className).toContain('min-h-11')
    const search = container.querySelector('search') as HTMLElement
    expect(search.contains(buttons[0])).toBe(false)
    expect(buttons[0].parentElement?.contains(screen.getByRole('button', { name: i18n.t('cards.table.export') }))).toBe(true)

    const user = userEvent.setup()
    await user.click(buttons[0])
    expect(onNewPurchase).toHaveBeenCalledTimes(1)
  })
})
