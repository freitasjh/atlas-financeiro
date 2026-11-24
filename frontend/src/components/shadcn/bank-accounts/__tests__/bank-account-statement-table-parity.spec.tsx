// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { BankAccountStatementTable } from '../bank-account-statement-table'
import { BankAccountsView } from '../bank-accounts-view'
import type { BankStatementTransaction } from '../bank-accounts-types'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

const PENDING_TX: BankStatementTransaction = {
  id: 't1',
  accountId: 'acc-1',
  date: '13/11/2026',
  description: 'Pagamento pendente',
  category: 'Fornecedores',
  amount: 50,
  type: 'debit',
  reconciliationStatus: 'pending',
}

function renderTable(props: Partial<React.ComponentProps<typeof BankAccountStatementTable>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <BankAccountStatementTable account={null} transactions={[PENDING_TX]} {...props} />
    </I18nextProvider>,
  )
}

afterEach(async () => {
  cleanup()
  vi.clearAllMocks()
  await i18n.changeLanguage('pt-BR')
})

describe('whenGalleryStatementRenders_thenFiltersMatchTheRouteContract', () => {
  it('usa <search> com input type=search e escala de texto da rota (D-C4/A17)', () => {
    const { container } = renderTable()

    const search = container.querySelector('search')
    expect(search).not.toBeNull()

    const searchbox = screen.getByRole('searchbox', { name: i18n.t('accounts.statement.searchAria') })
    expect(searchbox.getAttribute('type')).toBe('search')
    expect(searchbox.className).toContain('text-base')
    expect(searchbox.className).toContain('sm:text-sm')
    expect(searchbox.className).toContain('h-10')
    expect(searchbox.className).toContain('sm:h-9')

    expect(container.querySelectorAll('[role="radiogroup"]').length).toBe(2)
  })

  it('alvos de toque dos toggles têm 44px no mobile e densidade em diante (D-C4/A18)', () => {
    renderTable()

    for (const name of [i18n.t('accounts.statement.all'), i18n.t('accounts.statement.reconciled')]) {
      const item = screen.getByRole('radio', { name })
      expect(item.className).toContain('min-h-11')
      expect(item.className).toContain('sm:min-h-9')
    }
  })

  it('exportação segue o mesmo alvo de toque da rota (D-C4/A18)', () => {
    renderTable({ onExportStatement: () => {} })

    for (const name of ['CSV', 'OFX']) {
      const button = screen.getByRole('button', { name })
      expect(button.className).toContain('min-h-11')
      expect(button.className).toContain('sm:h-8')
      expect(button.className).toContain('sm:min-h-8')
    }
  })
})

describe('whenGalleryStatementHasNoReconcileHandler_thenNoSuccessToastIsFaked', () => {
  it('sem handler não concilia nem afirma sucesso (D-C4/A19)', async () => {
    const user = userEvent.setup()
    renderTable()

    await user.click(screen.getByRole('button', { name: i18n.t('accounts.statement.reconcile') }))

    expect(toastMocks.success).not.toHaveBeenCalled()
    expect(toastMocks.info).not.toHaveBeenCalled()
  })

  it('com handler delega e só então confirma (D-C4/A19)', async () => {
    const user = userEvent.setup()
    const onReconcile = vi.fn()
    renderTable({ onReconcileTransaction: onReconcile })

    await user.click(screen.getByRole('button', { name: i18n.t('accounts.statement.reconcile') }))

    expect(onReconcile).toHaveBeenCalledWith('t1')
    expect(toastMocks.success).toHaveBeenCalledTimes(1)
  })
})

describe('whenGalleryExportsStatement_thenToastIsHonest', () => {
  it('exportação da vitrine não afirma sucesso de download (D-C4/A19)', async () => {
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={i18n}>
        <BankAccountsView />
      </I18nextProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'CSV' }))

    expect(toastMocks.success).not.toHaveBeenCalled()
    expect(toastMocks.info).toHaveBeenCalledWith(
      i18n.t('accounts.exportUnavailable', { format: 'CSV' }),
    )
  })
})
