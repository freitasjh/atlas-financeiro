// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { BankAccountsView } from '../bank-accounts-view'
import { DeleteAccountDialog } from '../delete-account-dialog'
import { MOCK_BANK_ACCOUNTS } from '../bank-accounts-types'

afterEach(() => cleanup())

// Galeria de exemplos: smoke test da vitrine interativa com mocks.
// O comportamento real (cents/CRUD) é coberto em src/modules/accounts.
describe('whenGalleryRenders_thenMockShowcaseIsInteractive', () => {
  it('renderiza a vitrine com os mocks sem quebrar', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BankAccountsView />
      </I18nextProvider>,
    )

    expect(screen.getByText('Contas Bancárias & Tesouraria')).toBeTruthy()
    expect(screen.getByText(/Itaú • Operacional Matriz/)).toBeTruthy()
  })

  it('valores monetários da vitrine usam tabular-nums', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <BankAccountsView initialAccounts={MOCK_BANK_ACCOUNTS.slice(0, 1)} initialViewMode="grid" />
      </I18nextProvider>,
    )

    expect(container.querySelectorAll('.tabular-nums').length).toBeGreaterThan(0)
  })

  it('dialog de exemplo usa a variante sem nome quando vazio', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <DeleteAccountDialog open accountName="" error={null} isDeleting={false} onOpenChange={() => {}} onConfirm={() => {}} />
      </I18nextProvider>,
    )

    expect(screen.queryByText(/""/)).toBeNull()
    expect(screen.getByText(i18n.t('accounts.deleteHintFallback'))).toBeTruthy()
  })

  it('CTA de transferência da vitrine usa token de ação (A-C2)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BankAccountsView />
      </I18nextProvider>,
    )

    const cta = screen.getByRole('button', { name: 'Transferência Entre Contas' })
    expect(cta.className).toContain('bg-primary')
    expect(cta.className).toContain('text-primary-foreground')
    expect(cta.className).not.toContain('bg-emerald-600')
    expect(cta.className).not.toContain('text-white')
  })
})
