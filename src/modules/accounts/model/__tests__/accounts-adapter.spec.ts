import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import {
  accountRowToBankAccount,
  demoStatementForAccounts,
  transactionRowToStatementTx,
  editBankAccountInputToPatch,
  newBankAccountInputToCreate,
  toBankAccountType,
  toBankInstitutionCode,
} from '../accounts.adapter'
import type { AccountRow } from '../../service/accounts.service'
import type { AccountViewItem } from '../view-model'

function row(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    user_id: '99999999-8888-7777-6666-555555555555',
    tenant_id: null,
    name: 'Itaú • Operacional',
    type: 'checking',
    initial_balance_cents: 100000,
    current_balance_cents: 18452040,
    color: null,
    institution: 'itau',
    agency: '1234',
    account_number: '56789',
    account_digit: '0',
    is_default: true,
    connection_status: 'connected',
    created_at: '2026-11-01T12:00:00Z',
    updated_at: '2026-11-01T12:00:00Z',
    ...overrides,
  }
}

describe('whenAccountRowHasTemplateFields_thenAdapterMapsIdentityAndCents', () => {
  it('preserva BIGINT cents e dados de instituição/agência/conta', () => {
    const account = accountRowToBankAccount(row())

    expect(account.currentBalanceCents).toBe(18452040)
    expect(account.reconciledBalanceCents).toBe(18452040)
    expect(account.blockedBalanceCents).toBe(0)
    expect(account.institution).toBe('itau')
    expect(account.agency).toBe('1234')
    expect(account.accountNumber).toBe('56789')
    expect(account.accountDigit).toBe('0')
    expect(account.isDefault).toBe(true)
    expect(account.connectionStatus).toBe('connected')
    expect(account.type).toBe('checking')
    expect(Number.isInteger(account.currentBalanceCents)).toBe(true)
  })
})

describe('whenAccountRowHasLegacyOrUnknownValues_thenAdapterFallsBack', () => {
  it('instituição desconhecida vira other', () => {
    expect(toBankInstitutionCode('banco-inexistente')).toBe('other')
    expect(toBankInstitutionCode(null)).toBe('other')
  })

  it('type cash (legado) vira physical_cash', () => {
    expect(toBankAccountType('cash')).toBe('physical_cash')
  })

  it('campos nulos usam placeholders do template', () => {
    const account = accountRowToBankAccount(
      row({ agency: null, account_number: null, account_digit: null, institution: null }),
    )

    expect(account.agency).toBe('---')
    expect(account.accountNumber).toBe('---')
    expect(account.accountDigit).toBe('---')
    expect(account.institution).toBe('other')
  })
})

describe('whenNewBankAccountInput_thenCreatePayloadUsesSnakeCaseAndCents', () => {
  it('encaminha institution/agency/account_number/account_digit e cents inteiros', () => {
    const payload = newBankAccountInputToCreate({
      name: 'Nubank • Cobranças',
      type: 'checking',
      institution: 'nubank',
      agency: '0001',
      accountNumber: '9876543',
      accountDigit: '2',
      initialBalanceCents: 123456,
      connectionStatus: 'manual',
      isDefault: true,
    })

    expect(payload).toEqual({
      name: 'Nubank • Cobranças',
      type: 'checking',
      initial_balance_cents: 123456,
      institution: 'nubank',
      agency: '0001',
      account_number: '9876543',
      account_digit: '2',
      is_default: true,
      connection_status: 'manual',
    })
    expect(JSON.stringify(payload)).not.toMatch(/balance.*\.\d/)
  })
})

describe('whenEditBankAccountInput_thenPatchExcludesBalanceFields', () => {
  it('só encaminha campos editáveis', () => {
    const patch = editBankAccountInputToPatch({
      name: 'Conta editada',
      type: 'investment',
      institution: 'btg',
      agency: '0001',
      accountNumber: '45210',
      accountDigit: '8',
    })

    expect(patch).toEqual({
      name: 'Conta editada',
      type: 'investment',
      institution: 'btg',
      agency: '0001',
      account_number: '45210',
      account_digit: '8',
    })
    expect(JSON.stringify(patch)).not.toMatch(/balance/i)
  })
})

const DEMO_ACCOUNT: AccountViewItem = {
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

describe('whenDemoStatementIsRequested_thenEmptyStatementIsReturned', () => {
  it('conta nova abre extrato vazio: sem DEMO-1/DEMO-2, sem linhas injetadas', () => {
    const rows = demoStatementForAccounts([DEMO_ACCOUNT], i18n.t, new Date(2026, 10, 13))

    expect(rows).toEqual([])
  })
})


import type { TransactionRow } from '../../../transactions/service/transactions.service'

function txRow(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: 'tx-1',
    user_id: 'u1',
    account_id: 'acc-1',
    tenant_id: null,
    amount_cents: 1425000,
    type: 'income',
    description: 'Recebimento PIX',
    category_id: 'cat-vendas',
    date: '2026-11-13',
    is_transfer: false,
    transfer_destination_account_id: null,
    reconciled: true,
    installment_plan_id: null,
    invoice_id: null,
    split_group_id: null,
    fitid: 'FIT-123',
    dedup_hash: null,
    installment_number: null,
    created_at: '2026-11-13T10:00:00Z',
    updated_at: '2026-11-13T10:00:00Z',
    ...overrides,
  }
}

describe('whenTransactionRowIsAdapted_thenStatementTxPreservesCentsAndType', () => {
  it('income vira credit e cents inteiros', () => {
    const view = transactionRowToStatementTx(txRow({ type: 'income', amount_cents: 1425000 }), {
      categoryName: 'Vendas',
    })
    expect(view.amountCents).toBe(1425000)
    expect(view.type).toBe('credit')
    expect(Number.isInteger(view.amountCents)).toBe(true)
    expect(view.accountId).toBe('acc-1')
    expect(view.id).toBe('tx-1')
    expect(view.date).toBe('13/11/2026')
    expect(view.description).toBe('Recebimento PIX')
    expect(view.category).toBe('Vendas')
    expect(view.documentNumber).toBe('FIT-123')
    expect(view.reconciliationStatus).toBe('reconciled')
  })

  it('sem lookup resolvido usa fallback honesto (nunca UUID cru)', () => {
    const view = transactionRowToStatementTx(txRow({ type: 'income', amount_cents: 1425000 }))
    expect(view.category).not.toContain('-')
  })

  it('expense vira debit', () => {
    const view = transactionRowToStatementTx(txRow({ type: 'expense', reconciled: false }))
    expect(view.type).toBe('debit')
    expect(view.reconciliationStatus).toBe('pending')
  })

  it('transfer_in vira credit e transfer_out vira debit', () => {
    const inView = transactionRowToStatementTx(txRow({ type: 'transfer_in', is_transfer: true }))
    const outView = transactionRowToStatementTx(txRow({ type: 'transfer_out', is_transfer: true }))
    expect(inView.type).toBe('credit')
    expect(outView.type).toBe('debit')
  })

  it('empty honesto: description vazia usa fallback', () => {
    const view = transactionRowToStatementTx(txRow({ description: '' }))
    expect(view.description).toContain('Lançamento')
  })
})
