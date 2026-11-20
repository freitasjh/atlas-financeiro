// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { BankAccountsView as GalleryView } from '@/components/shadcn/bank-accounts/bank-accounts-view'
import { MOCK_BANK_ACCOUNTS, MOCK_BANK_TRANSACTIONS } from '@/components/shadcn/bank-accounts/bank-accounts-types'
import { AccountsView } from '../AccountsView'
import { accountRowToBankAccount } from '../../model/accounts.adapter'
import type { AccountRow } from '../../service/accounts.service'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

function row(id: string, name: string, currentBalanceCents: number): AccountRow {
  return {
    id,
    user_id: 'u1',
    name,
    type: 'checking',
    initial_balance_cents: currentBalanceCents,
    current_balance_cents: currentBalanceCents,
    color: null,
    institution: 'itau',
    agency: '0001',
    account_number: '12345',
    account_digit: '0',
    is_default: false,
    connection_status: 'connected',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as unknown as AccountRow
}

// P3.1 — paridade /contas: a camada real replica os blocos da galeria
// (título, alternador, seletor, resumo, extrato) com o mesmo esqueleto.
describe('whenRealLayerRenders_thenBlocksMatchGalleryParity', () => {
  it('título + alternador + seletor + resumo + extrato presentes nos dois', () => {
    const rows = [row('a1', 'Conta Um', 100000), row('a2', 'Conta Dois', 200000)]
    const items = rows.map(accountRowToBankAccount)
    // Extrato honesto: conta nova abre vazia, sem linhas demo.
    const statements: never[] = []

    const gallery = render(
      <I18nextProvider i18n={i18n}>
        <GalleryView />
      </I18nextProvider>,
    )
    const galleryHeadings = gallery.container.querySelectorAll('h1').length
    const galleryButtons = gallery.container.querySelectorAll('button').length
    gallery.unmount()

    render(
      <I18nextProvider i18n={i18n}>
        <AccountsView accounts={items} transactions={statements} />
      </I18nextProvider>,
    )

    // Mesmo cabeçalho único e mesma ordem de blocos
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(galleryHeadings)
    expect(screen.getByText(i18n.t('accounts.templateTitle'))).toBeTruthy()
    expect(screen.getByRole('group', { name: i18n.t('accounts.toolbar.viewsAndAccounts') })).toBeTruthy()
    // Alternador de visão
    expect(screen.getByText(i18n.t('accounts.viewStatements'))).toBeTruthy()
    expect(screen.getByText(i18n.t('accounts.viewGrid'))).toBeTruthy()
    // Seletor consolidado + contas
    expect(screen.getByText(i18n.t('accounts.selector.consolidated'))).toBeTruthy()
    // Resumo + extrato
    expect(screen.getByText(i18n.t('accounts.statement.titleAll'))).toBeTruthy()
    // Contagem de botões na mesma ordem de grandeza (paridade estrutural)
    const realButtons = document.querySelectorAll('button').length
    expect(Math.abs(realButtons - galleryButtons)).toBeLessThanOrEqual(12)
  })

  it('modo grid exibe métricas + grade nos dois', () => {
    const items = [row('a1', 'Conta Um', 100000)].map(accountRowToBankAccount)

    render(
      <I18nextProvider i18n={i18n}>
        <GalleryView initialAccounts={MOCK_BANK_ACCOUNTS} initialTransactions={MOCK_BANK_TRANSACTIONS} initialViewMode="grid" />
      </I18nextProvider>,
    )
    const galleryCards = document.querySelectorAll('h3').length
    cleanup()

    render(
      <I18nextProvider i18n={i18n}>
        <AccountsView accounts={items} initialViewMode="grid" />
      </I18nextProvider>,
    )

    expect(screen.getByText(i18n.t('accounts.metrics.consolidated'))).toBeTruthy()
    expect(within(document.body as HTMLElement).getAllByText(i18n.t('accounts.grid.add')).length).toBeGreaterThan(0)
    expect(galleryCards).toBeGreaterThan(0)
    expect(document.querySelectorAll('h3').length).toBeGreaterThan(0)
  })
})
