// @vitest-environment happy-dom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PillToggle } from '../pill-toggle'

const OPTIONS = [
  { value: 'all', label: 'Todos' },
  { value: 'in', label: 'Entradas' },
  { value: 'out', label: 'Saídas' },
] as const

function Controlled({ onChange }: { onChange?: (value: string) => void } = {}) {
  const [value, setValue] = useState<string>('all')
  return (
    <PillToggle
      size="lg"
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
      aria-label="Filtrar por tipo"
      options={OPTIONS.map((option) => ({ ...option }))}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('whenPillToggleRenders_thenItExposesRadioSemantics', () => {
  it('container é radiogroup rotulado e itens são radios com aria-checked', () => {
    render(<Controlled />)

    const group = screen.getByRole('radiogroup', { name: 'Filtrar por tipo' })
    expect(group).toBeTruthy()

    expect(screen.getByRole('radio', { name: 'Todos' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Entradas' }).getAttribute('aria-checked')).toBe('false')
  })
})

describe('whenPillToggleUsesRovingTabindex_thenOnlyActiveItemIsTabbable', () => {
  it('ativo tabIndex=0, demais -1', () => {
    render(<Controlled />)

    expect(screen.getByRole('radio', { name: 'Todos' }).getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('radio', { name: 'Entradas' }).getAttribute('tabindex')).toBe('-1')
    expect(screen.getByRole('radio', { name: 'Saídas' }).getAttribute('tabindex')).toBe('-1')
  })

  it('tab a partir do container foca o item ativo (um único tab stop)', async () => {
    const user = userEvent.setup()
    render(<Controlled />)

    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Todos' }))
  })
})

describe('whenArrowKeysAreUsed_thenFocusAndSelectionFollow', () => {
  it('ArrowRight avança e seleciona; ArrowLeft volta com wrap', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    screen.getByRole('radio', { name: 'Todos' }).focus()

    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Entradas' }))
    expect(screen.getByRole('radio', { name: 'Entradas' }).getAttribute('aria-checked')).toBe('true')
    expect(onChange).toHaveBeenLastCalledWith('in')

    await user.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Todos' }))
    expect(onChange).toHaveBeenLastCalledWith('all')

    // wrap: do primeiro para o último
    await user.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Saídas' }))
    expect(onChange).toHaveBeenLastCalledWith('out')
  })

  it('ArrowUp/ArrowDown funcionam como setas verticais', async () => {
    const user = userEvent.setup()
    render(<Controlled />)

    screen.getByRole('radio', { name: 'Todos' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Entradas' }))
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Todos' }))
  })

  it('Home vai ao primeiro e End ao último', async () => {
    const user = userEvent.setup()
    render(<Controlled />)

    screen.getByRole('radio', { name: 'Entradas' }).focus()
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Saídas' }))
    expect(screen.getByRole('radio', { name: 'Saídas' }).getAttribute('aria-checked')).toBe('true')

    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Todos' }))
    expect(screen.getByRole('radio', { name: 'Todos' }).getAttribute('aria-checked')).toBe('true')
  })
})

describe('whenActiveItemIsClickedAgain_thenSelectionDoesNotReset', () => {
  it('clicar no item ativo mantém aria-checked e emite o mesmo valor', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    const active = screen.getByRole('radio', { name: 'Todos' })
    await user.click(active)

    expect(onChange).toHaveBeenLastCalledWith('all')
    expect(screen.getByRole('radio', { name: 'Todos' }).getAttribute('aria-checked')).toBe('true')
  })
})

describe('whenPillToggleUsesSizeLg_thenTouchTargetAndMotionPreferencesHold', () => {
  it('item tem 44px no mobile, densidade no desktop e respeita prefers-reduced-motion', () => {
    render(<Controlled />)

    const item = screen.getByRole('radio', { name: 'Entradas' })
    expect(item.className).toContain('min-h-11')
    expect(item.className).toContain('sm:min-h-9')
    expect(item.className).toContain('motion-reduce:transition-none')
    expect(item.className).toContain('focus-visible:ring-2')
  })
})
