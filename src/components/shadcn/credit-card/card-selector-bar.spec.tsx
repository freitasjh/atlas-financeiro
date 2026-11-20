// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { formatCentsBRL } from '@/lib/utils'
import { CardSelectorBar } from './card-selector-bar'

const TEMPLATE_SOURCE = readFileSync(join(__dirname, 'card-selector-bar.tsx'), 'utf8')

function selectorCard(overrides: Partial<React.ComponentProps<typeof CardSelectorBar>['cards'][number]> = {}) {
  return {
    id: 'c-1',
    nickname: 'Nubank Final 1234',
    brand: 'visa' as const,
    last4: '1234',
    theme: 'violet' as const,
    isDefault: false,
    amountCents: 120000,
    ...overrides,
  }
}

function renderSelector(
  overrides: Partial<React.ComponentProps<typeof CardSelectorBar>> = {},
) {
  return render(
    <I18nextProvider i18n={i18n}>
      <CardSelectorBar
        cards={[selectorCard()]}
        selectedCardId="c-1"
        totalConsolidatedCents={340000}
        onSelectCard={vi.fn()}
        onAddNewCard={vi.fn()}
        {...overrides}
      />
    </I18nextProvider>,
  )
}

afterEach(() => {
  cleanup()
  void i18n.changeLanguage('pt-BR')
})

describe('whenTemplateReceivesCents_thenMoneyUsesCanonicalFormatter', () => {
  it('total consolidado e fatura do cartão são formatados via formatCentsBRL', () => {
    renderSelector()

    const money = (cents: number) => (text: string) =>
      text.replace(/\s/g, '') === formatCentsBRL(cents).replace(/\s/g, '')
    expect(screen.getByText(money(340000))).toBeTruthy()
    expect(screen.getByText(money(120000))).toBeTruthy()
  })

  it('componente não converte centavos em reais nem cria Intl próprio', () => {
    expect(TEMPLATE_SOURCE).toContain('formatCentsBRL')
    expect(TEMPLATE_SOURCE).toContain('totalConsolidatedCents')
    expect(TEMPLATE_SOURCE).not.toContain('Intl.NumberFormat')
    expect(TEMPLATE_SOURCE).not.toMatch(/\/\s*100\b/)
    expect(TEMPLATE_SOURCE).not.toContain('formatBRL')
  })

  it('valores usam font-mono tabular-nums', () => {
    const { container } = renderSelector()
    expect(container.querySelectorAll('.font-mono.tabular-nums').length).toBeGreaterThanOrEqual(2)
  })
})

describe('whenTemplateLayoutIsPreserved_thenOrderAndGeometryStay', () => {
  it('ordem: Novo Cartão → divisor → consolidado → chevron esq → trilho → chevron dir', () => {
    const { container } = renderSelector()
    const root = container.firstElementChild as HTMLElement | null
    const children = Array.from(root?.children ?? [])

    expect(children).toHaveLength(6)
    expect(children[0]?.tagName).toBe('BUTTON')
    expect(children[0]?.className).toContain('border-dashed')
    expect(children[0]?.className).toContain('h-[52px]')
    expect(children[1]?.className).toContain('w-px')
    expect(children[2]?.textContent).toContain(i18n.t('cards.selector.consolidated'))
    expect(children[3]?.querySelector('svg')).toBeTruthy()
    expect(children[4]?.className).toContain('scrollbar-none')
    expect(children[5]?.querySelector('svg')).toBeTruthy()
  })

  it('chips e botão novo mantêm altura h-[52px] do template', () => {
    renderSelector()

    const consolidated = screen.getByRole('button', {
      name: new RegExp(i18n.t('cards.selector.consolidated')),
    })
    const card = screen.getByRole('button', { name: new RegExp('Nubank Final 1234') })
    for (const chip of [consolidated, card]) expect(chip.className).toContain('h-[52px]')
  })

  it('estratos temáticos, last4, Star e dot de status são preservados', () => {
    const { container } = renderSelector({
      cards: [
        selectorCard({ id: 'c-2', isDefault: true, last4: '5678', status: 'paid' }),
      ],
      selectedCardId: 'c-2',
    })

    expect(container.querySelector('.bg-gradient-to-br')).toBeTruthy()
    expect(screen.getByText(/5678/)).toBeTruthy()
    expect(container.querySelector('.fill-amber-500')).toBeTruthy()
    expect(container.querySelector('.bg-emerald-500')).toBeTruthy()
  })
})

describe('whenTemplateIsInteracted_thenCallbacksAndI18nHold', () => {
  it('Novo Cartão dispara apenas onAddNewCard, com rótulo i18n', () => {
    const onAddNewCard = vi.fn()
    renderSelector({ onAddNewCard })

    fireEvent.click(screen.getByRole('button', { name: i18n.t('cards.new') }))
    expect(onAddNewCard).toHaveBeenCalledTimes(1)
  })

  it('chips disparam onSelectCard com id vazio no consolidado e id do cartão', () => {
    const onSelectCard = vi.fn()
    renderSelector({ onSelectCard })

    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(i18n.t('cards.selector.consolidated')) }),
    )
    fireEvent.click(screen.getByRole('button', { name: /Nubank Final 1234/ }))
    expect(onSelectCard).toHaveBeenNthCalledWith(1, '')
    expect(onSelectCard).toHaveBeenNthCalledWith(2, 'c-1')
  })

  it('chevrons rolam a trilho nos dois sentidos, com aria-label i18n', () => {
    renderSelector()
    const left = screen.getByRole('button', { name: i18n.t('cards.selector.scrollLeft') })
    const right = screen.getByRole('button', { name: i18n.t('cards.selector.scrollRight') })
    const strip = left.parentElement?.parentElement?.children[4] as HTMLElement | undefined
    const scrollBy = vi.fn()
    if (strip) Object.defineProperty(strip, 'scrollBy', { value: scrollBy, configurable: true })

    fireEvent.click(left)
    fireEvent.click(right)

    expect(scrollBy).toHaveBeenCalledTimes(2)
    const first = scrollBy.mock.calls[0]?.[0] as { left: number }
    const second = scrollBy.mock.calls[1]?.[0] as { left: number }
    expect(first.left).toBeLessThan(0)
    expect(second.left).toBeGreaterThan(0)
  })

  it('en-US traduz rótulos sem literal hardcoded', async () => {
    await i18n.changeLanguage('en-US')
    renderSelector()

    expect(screen.getByRole('button', { name: i18n.t('cards.new') }).textContent).toContain('New card')
    expect(
      screen.getByRole('button', { name: new RegExp(i18n.t('cards.selector.consolidated')) }).textContent,
    ).toContain('Consolidated')
  })
})
