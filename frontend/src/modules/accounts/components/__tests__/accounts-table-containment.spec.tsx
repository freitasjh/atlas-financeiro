// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { StatementTable } from '../StatementTable'
import type { AccountViewItem, StatementTxView } from '../../model/view-model'

function account(id: string, name: string): AccountViewItem {
  return {
    id,
    nickname: name,
    institution: 'itau',
    type: 'checking',
    agency: '0001',
    accountNumber: '12345',
    accountDigit: '0',
    currentBalanceCents: 100000,
    reconciledBalanceCents: 100000,
    blockedBalanceCents: 0,
    isDefault: false,
    connectionStatus: 'connected',
  }
}

const ACCOUNT = account('acc-1', 'Conta Um')

const LONG_DESCRIPTION =
  'Pagamento de fornecedor com descrição extremamente longa para provar que a coluna de descrição trunca em vez de empurrar valor, status e ação para fora da viewport'

function tx(overrides: Partial<StatementTxView> = {}): StatementTxView {
  return {
    id: 'tx-1',
    accountId: 'acc-1',
    date: '2026-11-13',
    description: LONG_DESCRIPTION,
    category: 'Fornecedores',
    amountCents: 45000,
    type: 'debit',
    reconciliationStatus: 'pending',
    ...overrides,
  }
}

function renderWithI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenStatementRowIsLong_thenDescriptionIsContained', () => {
  it('célula de descrição limita a largura e o wrapper tem min-w-0 (A-C3)', () => {
    renderWithI18n(<StatementTable account={ACCOUNT} transactions={[tx()]} />)

    const descriptionCell = screen.getByText(LONG_DESCRIPTION).closest('td')
    expect(descriptionCell).not.toBeNull()
    expect(descriptionCell?.className).toContain('w-[36%]')
    expect(descriptionCell?.className).toContain('max-w-[380px]')

    const innerWrapper = descriptionCell?.querySelector('div')
    expect(innerWrapper?.className).toContain('min-w-0')
    expect(innerWrapper?.className).toContain('max-w-full')
  })

  it('tabela usa layout fixo e o card externo não estoura a largura (A-C3)', () => {
    const { container } = renderWithI18n(<StatementTable account={ACCOUNT} transactions={[tx()]} />)

    const table = container.querySelector('table')
    expect(table?.className).toContain('table-fixed')

    const card = container.firstElementChild
    expect(card?.className).toContain('min-w-0')
    expect(card?.className).toContain('max-w-full')
  })

  it('overflow-x permanece apenas como fallback (min-w na tabela)', () => {
    const { container } = renderWithI18n(<StatementTable account={ACCOUNT} transactions={[tx()]} />)

    const scroll = container.querySelector('.overflow-x-auto')
    expect(scroll).not.toBeNull()
    const table = container.querySelector('table')
    expect(table?.className).toContain('min-w-[680px]')
  })
})

describe('whenExportButtonsRender_thenTouchTargetIsAccessible', () => {
  it('CSV/OFX têm 44px no mobile e 32px a partir de sm (A-A8)', () => {
    renderWithI18n(<StatementTable account={ACCOUNT} transactions={[tx()]} />)

    for (const name of ['CSV', 'OFX']) {
      const button = screen.getByRole('button', { name })
      expect(button.className).toContain('min-h-11')
      expect(button.className).toContain('sm:h-8')
    }
  })
})
