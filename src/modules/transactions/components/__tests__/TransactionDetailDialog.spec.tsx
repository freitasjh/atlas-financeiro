// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'

import { TransactionDetailDialog } from '../TransactionDetailDialog'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

function renderDetail(overrides?: {
  transaction?: any
  onEdit?: (tx: any) => void
  onDelete?: (id: string) => void
  onToggleReconciled?: (id: string, reconciled: boolean) => void
}) {
  const transaction = overrides?.transaction ?? {
    id: 't1',
    accountId: 'acc-1',
    categoryId: 'cat-1',
    categoryName: 'Categoria',
    accountName: 'Conta',
    date: '2026-05-10',
    amountCents: 100000,
    description: 'Lançamento teste',
    type: 'income',
    status: 'posted',
    reconciled: false,
  }
  const onOpenChange = vi.fn()
  render(
    <I18nextProvider i18n={i18n}>
      <TransactionDetailDialog
        transaction={transaction}
        open
        onOpenChange={onOpenChange}
        onEdit={overrides?.onEdit}
        onDelete={overrides?.onDelete}
        onToggleReconciled={overrides?.onToggleReconciled}
      />
    </I18nextProvider>,
  )
  return { onOpenChange }
}

describe('whenTransactionDetailRenders_thenShowsRealFields', () => {
  it('exibe descrição, valor em cents formatado, tipo, data e conta', () => {
    renderDetail()
    expect(screen.getByText('Lançamento teste')).toBeTruthy()
    expect(screen.getByText('10/05/2026')).toBeTruthy()
  })
})

describe('whenDetailConciliarClicked_thenCallsToggle', () => {
  it('chama onToggleReconciled com true', async () => {
    const user = userEvent.setup()
    const onToggleReconciled = vi.fn()
    renderDetail({ onToggleReconciled })
    await user.click(screen.getByRole('button', { name: /Conciliar/ }))
    expect(onToggleReconciled).toHaveBeenCalledWith('t1', true)
  })
})

describe('whenDetailDeleteClicked_thenCallsDelete', () => {
  it('chama onDelete com id', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    renderDetail({ onDelete })
    await user.click(screen.getByRole('button', { name: /Excluir/ }))
    expect(onDelete).toHaveBeenCalledWith('t1')
  })
})

describe('whenDetailEditClicked_thenCallsOnEdit', () => {
  it('chama onEdit com a transação', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    renderDetail({ onEdit })
    await user.click(screen.getByRole('button', { name: /Editar/ }))
    expect(onEdit).toHaveBeenCalled()
  })
})
