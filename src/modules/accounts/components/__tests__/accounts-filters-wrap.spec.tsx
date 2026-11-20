// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { StatementTable } from '../StatementTable'
import type { AccountViewItem } from '../../model/view-model'

const ACCOUNT: AccountViewItem = {
  id: 'acc-1',
  nickname: 'Conta Um',
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

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenViewportIsNarrow_thenFiltersWrapWithoutCuttingLabels', () => {
  it('container dos filtros quebra linha em vez de cortar o 2º grupo (B-A14)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StatementTable account={ACCOUNT} transactions={[]} />
      </I18nextProvider>,
    )

    const typeGroup = screen.getByRole('radiogroup', {
      name: i18n.t('accounts.statement.typeFilterAria'),
    })
    const container = typeGroup.parentElement as HTMLElement

    expect(container.className).toContain('flex-wrap')
    expect(container.className).not.toContain('overflow-x-auto')
    expect(container.className).not.toContain('truncate')
  })

  it('os dois grupos continuam acessíveis com labels completos (B-A14)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StatementTable account={ACCOUNT} transactions={[]} />
      </I18nextProvider>,
    )

    expect(
      screen.getByRole('radio', { name: i18n.t('accounts.statement.statusAll') }),
    ).toBeTruthy()
    expect(
      screen.getByRole('radio', { name: i18n.t('accounts.statement.pending') }),
    ).toBeTruthy()
    const group = screen.getByRole('radiogroup', {
      name: i18n.t('accounts.statement.statusFilterAria'),
    })
    expect(group.className).not.toContain('truncate')
  })
})
