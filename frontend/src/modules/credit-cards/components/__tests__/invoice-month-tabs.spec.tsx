// @vitest-environment happy-dom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { InvoiceMonthTabs } from '@/components/shadcn/credit-card/invoice-month-tabs'
import type { CardInvoice } from '@/components/shadcn/credit-card/statement-types'

type Props = Parameters<typeof InvoiceMonthTabs>[0]

const PERIODS = Array.from({ length: 10 }, (_, index) => `2026-${String(12 - index).padStart(2, '0')}`)
const TOTALS: Record<string, number> = { [PERIODS[0]]: 12345 }

const originalScrollIntoView = Element.prototype.scrollIntoView
const originalMatchMedia = window.matchMedia
let scrollIntoView: ReturnType<typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>>
let reducedMotion = false

function renderTabs(overrides: Partial<Props> = {}) {
  const onSelect = vi.fn()
  const view = render(
    <I18nextProvider i18n={i18n}>
      <InvoiceMonthTabs
        periodCodes={PERIODS}
        active={PERIODS[0]}
        totals={TOTALS}
        onSelect={onSelect}
        {...overrides}
      />
    </I18nextProvider>,
  )
  return { ...view, onSelect }
}

function tabFor(code: string): HTMLElement {
  const tab = document.querySelector<HTMLElement>(`[data-period-code="${code}"]`)
  if (!tab) throw new Error(`tab ausente: ${code}`)
  return tab
}

function renderControlled(initialActive: string) {
  const onSelect = vi.fn()
  function Harness() {
    const [active, setActive] = useState(initialActive)
    return (
      <I18nextProvider i18n={i18n}>
        <InvoiceMonthTabs
          periodCodes={PERIODS}
          active={active}
          totals={TOTALS}
          onSelect={(code) => {
            onSelect(code)
            setActive(code)
          }}
        />
      </I18nextProvider>
    )
  }
  return { ...render(<Harness />), onSelect }
}

function selectionState() {
  const tabs = [...document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')]
  return {
    selected: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.dataset.periodCode),
    tabbable: tabs.filter((tab) => tab.tabIndex === 0).map((tab) => tab.dataset.periodCode),
    codes: tabs.map((tab) => tab.dataset.periodCode),
  }
}

beforeEach(() => {
  scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>()
  Element.prototype.scrollIntoView = scrollIntoView
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reducedMotion && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as typeof window.matchMedia
})

afterEach(() => {
  cleanup()
  Element.prototype.scrollIntoView = originalScrollIntoView
  window.matchMedia = originalMatchMedia
  document.documentElement.classList.remove('dark')
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
  reducedMotion = false
  void i18n.changeLanguage('pt-BR')
})

describe('whenMounted_thenFirstTabIsOpenInvoiceByDefault', () => {
  it('quando active não é informado, seleciona a primeira fatura (fatura aberta / mais recente)', () => {
    renderTabs({ active: null })

    const firstTab = tabFor(PERIODS[0])
    expect(firstTab.getAttribute('aria-selected')).toBe('true')
    expect(firstTab.tabIndex).toBe(0)
    expect(screen.getByRole('tablist').contains(firstTab)).toBe(true)
  })

  it('quando recebe lista de faturas, a fatura aberta é posicionada como primeira aba', () => {
    const invoices: CardInvoice[] = [
      {
        id: 'inv-1',
        cardId: 'c1',
        period: 'Outubro 2026',
        periodCode: '2026-10',
        status: 'paid',
        closingDate: '03/10/2026',
        dueDate: '10/10/2026',
        totalAmount: 100,
        totalCents: 10000,
        minimumPayment: 15,
        barcode: '',
        pixCopyPaste: '',
      },
      {
        id: 'inv-2',
        cardId: 'c1',
        period: 'Novembro 2026',
        periodCode: '2026-11',
        status: 'closed',
        closingDate: '03/11/2026',
        dueDate: '10/11/2026',
        totalAmount: 200,
        totalCents: 20000,
        minimumPayment: 30,
        barcode: '',
        pixCopyPaste: '',
      },
      {
        id: 'inv-3',
        cardId: 'c1',
        period: 'Dezembro 2026',
        periodCode: '2026-12',
        status: 'open',
        closingDate: '03/12/2026',
        dueDate: '10/12/2026',
        totalAmount: 300,
        totalCents: 30000,
        minimumPayment: 45,
        barcode: '',
        pixCopyPaste: '',
      },
    ]

    render(
      <I18nextProvider i18n={i18n}>
        <InvoiceMonthTabs invoices={invoices} />
      </I18nextProvider>,
    )

    const tabs = screen.getAllByRole('tab')
    expect(tabs[0].getAttribute('data-period-code')).toBe('2026-12')
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
  })

  it('rola o chip ativo com inline/nearest e behavior smooth', () => {
    renderTabs({ active: PERIODS[0] })

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  })
})

describe('whenActiveChangesExternally_thenUpdatesSelection', () => {
  it('troca externa de active seleciona o novo tab', () => {
    const { rerender } = renderTabs({ active: PERIODS[0] })
    expect(tabFor(PERIODS[0]).getAttribute('aria-selected')).toBe('true')

    rerender(
      <I18nextProvider i18n={i18n}>
        <InvoiceMonthTabs
          periodCodes={PERIODS}
          active={PERIODS[5]}
          totals={TOTALS}
          onSelect={vi.fn()}
        />
      </I18nextProvider>,
    )

    expect(tabFor(PERIODS[5]).getAttribute('aria-selected')).toBe('true')
    expect(tabFor(PERIODS[0]).getAttribute('aria-selected')).toBe('false')
  })
})

describe('whenArrowKeysArePressed_thenTabsFollowW3cApgWithoutWrap', () => {
  it('seta direita seleciona e foca o próximo tab', () => {
    const { onSelect } = renderControlled(PERIODS[4])
    const current = tabFor(PERIODS[4])
    current.focus()
    fireEvent.keyDown(current, { key: 'ArrowRight' })

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(PERIODS[5])
    expect(document.activeElement?.getAttribute('data-period-code')).toBe(PERIODS[5])
    expect(selectionState().selected).toEqual([PERIODS[5]])
  })

  it('seta esquerda seleciona e foca o tab anterior', () => {
    const { onSelect } = renderControlled(PERIODS[4])
    const current = tabFor(PERIODS[4])
    current.focus()
    fireEvent.keyDown(current, { key: 'ArrowLeft' })

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(PERIODS[3])
    expect(document.activeElement?.getAttribute('data-period-code')).toBe(PERIODS[3])
    expect(selectionState().selected).toEqual([PERIODS[3]])
  })

  it('não dá wrap nas pontas', () => {
    const first = renderControlled(PERIODS[0])
    fireEvent.keyDown(tabFor(PERIODS[0]), { key: 'ArrowLeft' })
    expect(first.onSelect).not.toHaveBeenCalled()

    cleanup()

    const last = renderControlled(PERIODS[9])
    fireEvent.keyDown(tabFor(PERIODS[9]), { key: 'ArrowRight' })
    expect(last.onSelect).not.toHaveBeenCalled()
  })

  it('Home e End selecionam as pontas', () => {
    const home = renderControlled(PERIODS[4])
    fireEvent.keyDown(tabFor(PERIODS[4]), { key: 'Home' })
    expect(home.onSelect).toHaveBeenCalledExactlyOnceWith(PERIODS[0])

    cleanup()

    const end = renderControlled(PERIODS[4])
    fireEvent.keyDown(tabFor(PERIODS[4]), { key: 'End' })
    expect(end.onSelect).toHaveBeenCalledExactlyOnceWith(PERIODS[9])
  })
})

describe('whenPrefersReducedMotion_thenScrollUsesAutoBehavior', () => {
  it('usa behavior auto em vez de smooth', () => {
    reducedMotion = true
    renderTabs()

    const calls = scrollIntoView.mock.calls as Array<[ScrollIntoViewOptions]>
    expect(calls.at(-1)?.[0]).toEqual({ behavior: 'auto', inline: 'nearest', block: 'nearest' })
  })
})

describe('whenRailIsRendered_thenItIsHorizontallyScrollable', () => {
  it('tablist não estica com flex-1 e possui overflow-x-auto', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    renderTabs({ active: PERIODS[0] })

    const rail = screen.getByRole('tablist')
    expect(rail.className).not.toContain('flex-1')
    expect(rail.className).toContain('min-w-0')
    expect(rail.className).toContain('overflow-x-auto')
  })
})

describe('whenSemanticTokensAreApplied_thenStateAndTouchTargetsAreAccessible', () => {
  it('ativo usa bg-primary/text-primary-foreground, inativos usam tokens mute; roving tabindex', () => {
    renderTabs({ active: PERIODS[4] })

    const activeTab = tabFor(PERIODS[4])
    expect(activeTab.className).toContain('bg-primary')
    expect(activeTab.className).toContain('text-primary-foreground')
    expect(activeTab.className).toContain('font-bold')
    expect(activeTab.tabIndex).toBe(0)

    const inactive = tabFor(PERIODS[3])
    expect(inactive.className).toContain('bg-muted/40')
    expect(inactive.className).toContain('text-muted-foreground')
    expect(inactive.tabIndex).toBe(-1)
  })

  it('exibe o micro-dot semântico de status da fatura', () => {
    renderTabs({
      active: PERIODS[0],
      statuses: {
        [PERIODS[0]]: 'open',
        [PERIODS[1]]: 'closed',
        [PERIODS[2]]: 'paid',
      },
    })

    const openDot = tabFor(PERIODS[0]).querySelector('[aria-hidden="true"]')
    expect(openDot?.className).toContain('bg-cyan')

    const closedDot = tabFor(PERIODS[1]).querySelector('[aria-hidden="true"]')
    expect(closedDot?.className).toContain('bg-amber')

    const paidDot = tabFor(PERIODS[2]).querySelector('[aria-hidden="true"]')
    expect(paidDot?.className).toContain('bg-emerald')
  })

  it('em dark não há cor fixa ou hexadecimal no componente', () => {
    document.documentElement.classList.add('dark')
    const { container } = renderTabs()

    expect(container.innerHTML).not.toContain('bg-white')
    expect(container.innerHTML).not.toContain('#fff')
    expect(container.innerHTML).not.toContain('bg-slate')
    expect(container.innerHTML).not.toContain('bg-gray')
  })
})
