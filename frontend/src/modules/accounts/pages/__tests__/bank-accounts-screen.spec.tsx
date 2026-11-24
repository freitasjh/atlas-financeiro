// @vitest-environment happy-dom
// QA-OFX-02 (P3) — regressão: adapter usa nome da categoria, nunca UUID cru.
// P1.3 — confirmação OFX migrou para /contas/importar; reload pós-confirm
// volta no Batch 2 (P2.3) com testes próprios da página.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'

const sbMocks = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from },
}))

vi.mock('@/modules/accounts/service/accounts.service', () => ({
  listAccounts: vi.fn(async () => []),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  recalcAccount: vi.fn(async () => {}),
}))

const captured = vi.hoisted(() => ({ props: null as unknown as Record<string, unknown> | null }))
vi.mock('@/modules/accounts/components/AccountsView', () => ({
  AccountsView: (props: Record<string, unknown>) => {
    captured.props = props
    return <div data-testid="accounts-view-stub" />
  },
}))

import '@/i18n'
import { BankAccountsScreen } from '../BankAccountsScreen'
import { useAccountsStore } from '../../store/accounts.store'
import { useTransactionsStore } from '@/modules/transactions/store/transactions.store'
import { transactionRowToStatementTx } from '../../model/accounts.adapter'

function accountRow(id: string) {
  return {
    id,
    user_id: 'u1',
    name: 'Conta',
    type: 'checking',
    initial_balance_cents: 100000,
    current_balance_cents: 100000,
    color: null,
    institution: null,
    agency: null,
    account_number: null,
    account_digit: null,
    is_default: false,
    connection_status: 'manual',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as never
}

function txRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    user_id: 'u1',
    account_id: 'acc-1',
    amount_cents: 2599,
    type: 'expense',
    description: 'Mercado',
    category_id: '11111111-2222-3333-4444-555555555555',
    date: '2026-11-13',
    is_transfer: false,
    transfer_destination_account_id: null,
    reconciled: true,
    installment_plan_id: null,
    invoice_id: null,
    split_group_id: null,
    fitid: null,
    dedup_hash: null,
    installment_number: null,
    created_at: '2026-11-13T10:00:00Z',
    updated_at: '2026-11-13T10:00:00Z',
    ...overrides,
  } as never
}

function categoriesOk(rows: Array<{ id: string; name: string }>) {
  const chain = { select: vi.fn(), order: vi.fn() }
  chain.select.mockReturnValue(chain)
  chain.order.mockResolvedValue({ data: rows, error: null })
  sbMocks.from.mockImplementation((table: string) => {
    if (table === 'categories') return chain
    throw new Error(`unexpected-table:${table}`)
  })
}

beforeEach(() => {
  cleanup()
  captured.props = null
  sbMocks.from.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('whenCategoryNameProvided_thenAdapterShowsNameNotUuid', () => {
  it('usa opts.categoryName em vez do UUID cru', () => {
    const view = transactionRowToStatementTx(txRow(), { categoryName: 'Alimentação' })
    expect(view.category).toBe('Alimentação')
  })

  it('sem lookup mantém fallback honesto (Sem categoria) e transferência preservada', () => {
    const noCat = transactionRowToStatementTx(txRow({ category_id: null }))
    expect(noCat.category).toContain('Sem categoria')
    const transfer = transactionRowToStatementTx(
      txRow({ is_transfer: true, type: 'transfer_out', category_id: null }),
    )
    expect(transfer.category).toContain('Transferência')
  })
})

// P1.3 — entry-point "Importar OFX" preservado como picker: a tela segue
// repassando CRUD/transfer ao AccountsView; confirmação e reload vivem na
// página /contas/importar (Batch 2).
describe('whenPickerEntryPreserved_thenScreenStillWiresAccountsView', () => {
  it('repassa contas e handlers de CRUD/transfer ao AccountsView', async () => {
    categoriesOk([])
    const loadAccounts = vi.fn(async () => {})
    const loadTransactions = vi.fn(async () => {})
    useAccountsStore.setState({ accounts: [accountRow('acc-1')], status: 'ready', error: null, load: loadAccounts })
    useTransactionsStore.setState({
      transactions: [txRow()],
      status: 'ready',
      error: null,
      count: 1,
      page: 1,
      pageSize: 50,
      load: loadTransactions,
    } as never)

    render(<BankAccountsScreen />)
    await waitFor(() => expect(captured.props).not.toBeNull())

    for (const key of ['accounts', 'onCreateAccount', 'onUpdateAccount', 'onDeleteAccount', 'onExecuteTransfer', 'onSelectAccount'] as const) {
      expect(typeof captured.props?.[key] === 'function' || Array.isArray(captured.props?.[key])).toBe(true)
    }
    expect(captured.props?.['onImportConfirmed']).toBeUndefined()
  })
})

describe('whenCategoryLookupPending_thenNoUuidFlash', () => {
  it('adapter com UUID desconhecido usa fallback honesto (sem traço de UUID)', () => {
    const view = transactionRowToStatementTx(txRow())
    expect(view.category).not.toContain('-')
  })

  it('tela pendente não exibe UUID cru antes do lookup resolver', async () => {
    // Lookup pendente: promise que nunca resolve durante a asserção.
    const chain = { select: vi.fn(), order: vi.fn(() => new Promise(() => {})) }
    chain.select.mockReturnValue(chain)
    sbMocks.from.mockImplementation((table: string) => {
      if (table === 'categories') return chain
      throw new Error(`unexpected-table:${table}`)
    })
    const loadAccounts = vi.fn(async () => {})
    const loadTransactions = vi.fn(async () => {})
    useAccountsStore.setState({ accounts: [accountRow('acc-1')], status: 'ready', error: null, load: loadAccounts })
    useTransactionsStore.setState({
      transactions: [txRow()],
      status: 'ready',
      error: null,
      count: 1,
      page: 1,
      pageSize: 50,
      load: loadTransactions,
    } as never)

    render(<BankAccountsScreen />)
    await waitFor(() => expect(captured.props).not.toBeNull())
    const txs = captured.props?.['transactions'] as Array<{ category: string }>
    expect(txs[0].category).not.toContain('-')
    expect(txs[0].category).not.toContain('11111111-2222')
  })
})

describe('whenStatementRenders_thenCategoryShowsNameNotUuid', () => {
  it('resolve category_id via lookup único e exibe o nome', async () => {
    categoriesOk([{ id: '11111111-2222-3333-4444-555555555555', name: 'Alimentação' }])
    const loadAccounts = vi.fn(async () => {})
    const loadTransactions = vi.fn(async () => {})
    useAccountsStore.setState({ accounts: [accountRow('acc-1')], status: 'ready', error: null, load: loadAccounts })
    useTransactionsStore.setState({
      transactions: [txRow()],
      status: 'ready',
      error: null,
      count: 1,
      page: 1,
      pageSize: 50,
      load: loadTransactions,
    } as never)

    render(<BankAccountsScreen />)
    // Lookup único de categorias (sem N+1): 1 query na tabela categories.
    await waitFor(() => {
      const calls = sbMocks.from.mock.calls.filter((c) => c[0] === 'categories')
      expect(calls).toHaveLength(1)
    })
    await waitFor(() => {
      const txs = captured.props?.['transactions'] as Array<{ category: string }>
      expect(txs?.[0]?.category).toBe('Alimentação')
    })
    const txs = captured.props?.['transactions'] as Array<{ category: string }>
    expect(txs[0].category).not.toContain('11111111-2222')
  })
})

// B-A12 — a tela repassa o estado dos lançamentos ao extrato (nunca vazio falso).
describe('whenTransactionsStoreFails_thenScreenForwardsStateAndRetry', () => {
  it('propaga transactionsStatus=error e um retry que recarrega', async () => {
    categoriesOk([])
    const loadAccounts = vi.fn(async () => {})
    const loadTransactions = vi.fn(async () => {})
    useAccountsStore.setState({ accounts: [accountRow('acc-1')], status: 'ready', error: null, load: loadAccounts })
    useTransactionsStore.setState({
      transactions: [],
      status: 'error',
      error: 'boom',
      count: 0,
      page: 1,
      pageSize: 50,
      load: loadTransactions,
    } as never)

    render(<BankAccountsScreen />)
    await waitFor(() => expect(captured.props).not.toBeNull())

    expect(captured.props?.['transactionsStatus']).toBe('error')
    const retry = captured.props?.['onRetryTransactions']
    expect(typeof retry).toBe('function')
    ;(retry as () => void)()
    await waitFor(() => expect(loadTransactions).toHaveBeenCalled())
  })

  it('propaga o total real do store para o rodapé honesto (D2)', async () => {
    categoriesOk([])
    const loadAccounts = vi.fn(async () => {})
    const loadTransactions = vi.fn(async () => {})
    useAccountsStore.setState({ accounts: [accountRow('acc-1')], status: 'ready', error: null, load: loadAccounts })
    useTransactionsStore.setState({
      transactions: [txRow()],
      status: 'ready',
      error: null,
      count: 1200,
      page: 1,
      pageSize: 1000,
      load: loadTransactions,
    } as never)

    render(<BankAccountsScreen />)
    await waitFor(() => expect(captured.props).not.toBeNull())

    expect(captured.props?.['transactionsTotalCount']).toBe(1200)
  })

  it('propaga transactionsStatus=loading durante o fetch inicial', async () => {
    categoriesOk([])
    const loadAccounts = vi.fn(async () => {})
    const loadTransactions = vi.fn(async () => {})
    useAccountsStore.setState({ accounts: [accountRow('acc-1')], status: 'ready', error: null, load: loadAccounts })
    useTransactionsStore.setState({
      transactions: [],
      status: 'loading',
      error: null,
      count: 0,
      page: 1,
      pageSize: 50,
      load: loadTransactions,
    } as never)

    render(<BankAccountsScreen />)
    await waitFor(() => expect(captured.props).not.toBeNull())

    expect(captured.props?.['transactionsStatus']).toBe('loading')
  })
})
