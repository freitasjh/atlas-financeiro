// @vitest-environment happy-dom
// O2.1/O2.2/O2.4 — ImportStagingTable: toolbar <search> (Regra Ação Única),
// contagens, badge amber em duplicado (não inserível), Confirmar(N), categoria inline.
import { describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { ImportStagingTable } from '../ImportStagingTable'
import type { StagedRow } from '../../hooks/useImportStaging'

function row(overrides: Partial<StagedRow> = {}): StagedRow {
  return {
    id: 'r1',
    date: '2026-11-01',
    description: 'PIX RECEBIDO de João',
    amount_cents: 15000,
    type: 'income',
    fitid: 'fit-1',
    dedup_hash: 'h1',
    category_id: null,
    selected: true,
    dup: false,
    ...overrides,
  }
}

const CATEGORIES = [
  { id: 'cat-pix', name: 'PIX' },
  { id: 'cat-mercado', name: 'Mercado' },
]

function renderTable(props: Partial<React.ComponentProps<typeof ImportStagingTable>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ImportStagingTable
        rows={[row(), row({ id: 'r2', description: 'Boleto luz', amount_cents: 20000, type: 'expense', selected: false, dup: true, dedup_hash: 'h2' })]}
        counts={{ new: 1, dup: 1, invalid: 1 }}
        confirmCount={1}
        allNewSelected={false}
        categories={CATEGORIES}
        onToggleRow={() => {}}
        onToggleAll={() => {}}
        onCategoryChange={() => {}}
        onConfirm={() => {}}
        {...props}
      />
    </I18nextProvider>,
  )
}

afterEach(() => cleanup())

describe('whenStagingTableRenders_thenCountsAndDupBadgeAreShown', () => {
  it('exibe contagem novos/duplicados/inválidos e badge amber no duplicado', () => {
    renderTable()
    expect(screen.getByText(i18n.t('accounts.staging.counts', { new: 1, dup: 1, invalid: 1 }))).toBeTruthy()
    expect(screen.getByText(i18n.t('accounts.staging.badgeDuplicate'))).toBeTruthy()
    expect(screen.getByText(/PIX RECEBIDO/)).toBeTruthy()
  })

  it('valores usam tabular-nums', () => {
    const { container } = renderTable()
    expect(container.querySelector('.tabular-nums')).toBeTruthy()
  })
})

describe('whenConfirmCountIsZero_thenButtonIsDisabled', () => {
  it('Confirmar(0) desabilitado; Confirmar(1) habilitado', () => {
    const { rerender } = renderTable({ confirmCount: 0 })
    expect((screen.getByRole('button', { name: i18n.t('accounts.staging.confirm', { count: 0 }) }) as HTMLButtonElement).disabled).toBe(true)

    rerender(
      <I18nextProvider i18n={i18n}>
        <ImportStagingTable
          rows={[row()]}
          counts={{ new: 1, dup: 0, invalid: 0 }}
          confirmCount={1}
          allNewSelected
          categories={CATEGORIES}
          onToggleRow={() => {}}
          onToggleAll={() => {}}
          onCategoryChange={() => {}}
          onConfirm={() => {}}
        />
      </I18nextProvider>,
    )
    expect((screen.getByRole('button', { name: i18n.t('accounts.staging.confirm', { count: 1 }) }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('whenBulkToggles_thenCallbacksFire', () => {
  it('checkbox da linha nova dispara onToggleRow; duplicado não tem checkbox', () => {
    const onToggleRow = vi.fn()
    renderTable({ onToggleRow })
    fireEvent.click(screen.getByRole('checkbox', { name: /PIX RECEBIDO/ }))
    expect(onToggleRow).toHaveBeenCalledWith('r1')
    expect(screen.queryByRole('checkbox', { name: /Boleto luz/ })).toBeNull()
  })

  it('selecionar-todos dispara onToggleAll', () => {
    const onToggleAll = vi.fn()
    renderTable({ onToggleAll })
    fireEvent.click(screen.getByRole('checkbox', { name: i18n.t('accounts.staging.selectAll') }))
    expect(onToggleAll).toHaveBeenCalled()
  })
})

describe('whenCategoryChanges_thenCallbackFires', () => {
  it('select inline chama onCategoryChange com o id escolhido', () => {
    const onCategoryChange = vi.fn()
    renderTable({ onCategoryChange })
    const select = screen.getByLabelText(i18n.t('accounts.staging.categoryLabel', { description: 'PIX RECEBIDO de João' }))
    fireEvent.change(select, { target: { value: 'cat-mercado' } })
    expect(onCategoryChange).toHaveBeenCalledWith('r1', 'cat-mercado')
  })
})
