// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import i18n from '@/i18n'
import { formatCentsBRL } from '@/lib/utils'
import type { ExpenseRow } from '@/components/shadcn/credit-card/card-expenses-table'
import { ExpenseDetailDialog } from '../ExpenseDetailDialog'

function expense(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: 'e-1',
    description: 'Mercado',
    date: '2026-09-15',
    amountCents: 1500,
    installmentLabel: null,
    categoryName: null,
    pending: false,
    isTransfer: false,
    cardLast4: null,
    ...overrides,
  }
}

function renderDetail(expenseRow: ExpenseRow) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ExpenseDetailDialog open onOpenChange={() => {}} expense={expenseRow} />
    </I18nextProvider>,
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenDetailRenders_thenTemplateHierarchyIsReconstructed', () => {
  it('exibe badge de categoria, ID, título, subtítulo com last4 real, bloco de valor e seção de dados', () => {
    renderDetail(expense({ categoryName: 'Alimentação', cardLast4: '1234', installmentLabel: 'Parc. 2' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Alimentação')).toBeTruthy()
    expect(within(dialog).getByText(/ID: e-1/)).toBeTruthy()
    expect(within(dialog).getByText('Mercado')).toBeTruthy()
    expect(within(dialog).getByText('Transação processada no cartão terminado em •••• 1234')).toBeTruthy()

    expect(within(dialog).getByText('Valor do Lançamento')).toBeTruthy()
    const expectedAmount = formatCentsBRL(1500, i18n.language).replace(/\s/g, ' ')
    const amount = within(dialog).getByText(
      (_content, element) => element?.tagName === 'SPAN' && (element.textContent ?? '').replace(/\s/g, ' ') === expectedAmount,
    )
    expect(amount.className).toContain('font-mono')
    expect(amount.className).toContain('text-2xl')
    expect(amount.className).toContain('font-extrabold')
    expect(amount.className).toContain('tabular-nums')
    expect(amount.parentElement?.className).toContain('rounded-xl')
    expect(amount.parentElement?.className).toContain('bg-muted/30')
    expect(amount.parentElement?.className).toContain('text-center')
    expect(within(dialog).getByText('Compra parcelada · Parc. 2')).toBeTruthy()

    expect(within(dialog).getByText('Dados do Lançamento')).toBeTruthy()
    expect(within(dialog).getByText(i18n.t('cards.detail.date'))).toBeTruthy()
    expect(within(dialog).getByText('2026-09-15')).toBeTruthy()
    expect(within(dialog).getByText('Cartão Utilizado')).toBeTruthy()
    expect(within(dialog).getByText('•••• 1234')).toBeTruthy()
  })

  it('campo de categoria presente usa o nome; ausente usa rótulo neutro', () => {
    renderDetail(expense({ categoryName: 'Alimentação', cardLast4: '1234' }))
    expect(within(screen.getByRole('dialog')).getByText('Alimentação')).toBeTruthy()
    cleanup()

    renderDetail(expense({ categoryName: null, cardLast4: '1234' }))
    expect(within(screen.getByRole('dialog')).getByText(i18n.t('cards.purchase.noCategory'))).toBeTruthy()
  })
})

describe('whenDetailRenders_thenNoInventedDataOrFakeActionsLeak', () => {
  it('não exibe Horário, Local, Notas, Recibo, Contestar ou valores mock da imagem', () => {
    renderDetail(expense({ cardLast4: '1234' }))

    const dialog = screen.getByRole('dialog')
    for (const forbidden of [
      'Horário',
      'Local / Origem',
      'Notas da Despesa',
      'Visualizar Recibo Fiscal',
      'Contestar',
      'Todos',
      '14:32',
      'São Paulo',
    ]) {
      expect(within(dialog).queryByText(new RegExp(forbidden, 'i'))).toBeNull()
    }

    const buttons = within(dialog).getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toBe(i18n.t('cards.detail.close'))
    expect(buttons[0]?.className).toContain('min-h-11')
  })

  it('código-fonte não contém alert() nem rótulos de ações falsas', () => {
    const source = readFileSync(join(__dirname, '..', 'ExpenseDetailDialog.tsx'), 'utf8')

    expect(source).not.toMatch(/\balert\s*\(/)
    for (const token of [
      'Recibo',
      'Contestar',
      'Horário',
      'Local / Origem',
      'Notas da Despesa',
      'MapPin',
      'Receipt',
      'AlertTriangle',
    ]) {
      expect(source.toLowerCase()).not.toContain(token.toLowerCase())
    }
  })
})

describe('whenLast4IsUnknown_thenDetailUsesNeutralFallback', () => {
  it('sem last4: subtítulo neutro e máscara sem número inventado', () => {
    renderDetail(expense({ cardLast4: null }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Transação processada em cartão')).toBeTruthy()
    expect(within(dialog).getByText('••••')).toBeTruthy()
    expect(within(dialog).queryByText(/terminado em/)).toBeNull()
  })

  it('sem parcela: não exibe badge de parcelamento', () => {
    renderDetail(expense({ installmentLabel: null, cardLast4: '1234' }))

    expect(within(screen.getByRole('dialog')).queryByText(/Compra parcelada/)).toBeNull()
  })
})

describe('whenLocaleChanges_thenDetailLabelsAreTranslated', () => {
  it('pt-BR e en-US definem as novas chaves e o runtime troca o subtítulo', async () => {
    expect(i18n.t('cards.detail.amountLabel')).toBe('Valor do Lançamento')
    expect(i18n.t('cards.detail.dataSection')).toBe('Dados do Lançamento')
    expect(i18n.t('cards.detail.cardUsed')).toBe('Cartão Utilizado')

    await i18n.changeLanguage('en-US')

    expect(i18n.t('cards.detail.processedOnCard', { last4: '1234' })).toBe(
      'Transaction processed on card ending in •••• 1234',
    )
    expect(i18n.t('cards.detail.processedOnCardUnknown')).toBe('Card transaction')
    expect(i18n.t('cards.detail.cardUsed')).toBe('Card used')
  })
})
