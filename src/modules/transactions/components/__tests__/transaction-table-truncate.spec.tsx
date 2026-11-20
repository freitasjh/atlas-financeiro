// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { TransactionTable } from '@/components/shadcn/transactions/transaction-table'
import type { Transaction } from '@/components/shadcn/transactions/transaction-types'

const LONG_DESCRIPTION =
  'Pix CNPJ 12.345.678/0001-90 ag 1234 cc 56789-0 pagamento fornecedor nota fiscal 000123456'

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    description: LONG_DESCRIPTION,
    amount: 1500.5,
    type: 'expense',
    category: 'Fornecedores',
    account: 'Conta Principal',
    paymentMethod: 'pix',
    status: 'completed',
    date: '2026-05-10',
    createdAt: '2026-05-10',
    ...overrides,
  }
}

function renderTable(transactions: Transaction[]) {
  return render(
    <TransactionTable
      transactions={transactions}
      onNewTransaction={vi.fn()}
      onSelectTransaction={vi.fn()}
      onEditTransaction={vi.fn()}
      onDeleteTransaction={vi.fn()}
      onToggleStatus={vi.fn()}
    />,
  )
}

afterEach(() => {
  cleanup()
})

describe('whenDescriptionIsLong_thenCellTruncatesWithFullTextTooltip', () => {
  it('aplica truncate na descricao e expoe o texto completo via title', () => {
    renderTable([tx()])
    const desc = screen.getByTitle(LONG_DESCRIPTION)
    expect(desc.textContent).toBe(LONG_DESCRIPTION)
    expect(desc.className).toMatch(/truncate/)
  })

  it('contem a largura com min-w-0 no container flex da celula', () => {
    const { container } = renderTable([tx()])
    const desc = screen.getByTitle(LONG_DESCRIPTION)
    const flexContainer = desc.parentElement
    expect(flexContainer?.className).toMatch(/min-w-0/)
    const cell = desc.closest('td')
    expect(cell?.className).toMatch(/max-w-/)
    expect(container.querySelector('table')).toBeTruthy()
  })
})
