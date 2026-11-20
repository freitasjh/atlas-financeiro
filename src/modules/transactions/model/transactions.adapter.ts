import i18n from '@/i18n'
import type { TransactionRow } from '../service/transactions.service'
import type { TransactionView, NewTransactionInput, EditTransactionInput } from './view-model'
import { deriveTransactionStatus } from './transaction'

export function transactionRowToTransactionView(
  row: TransactionRow,
  opts?: { accountName?: string; categoryName?: string },
): TransactionView {
  const isTransfer = Boolean(row.is_transfer)
  const type: TransactionView['type'] = isTransfer
    ? 'transfer'
    : row.type === 'income'
      ? 'income'
      : 'expense'
  return {
    id: row.id,
    accountId: row.account_id,
    categoryId: row.category_id,
    date: row.date,
    amountCents: row.amount_cents,
    description: row.description || i18n.t('transactions.noDescription', { defaultValue: 'Lançamento sem descrição' }),
    type,
    status: deriveTransactionStatus(Boolean(row.reconciled), row.date),
    installmentPlanId: row.installment_plan_id,
    accountName: opts?.accountName,
    categoryName: opts?.categoryName ?? (isTransfer ? i18n.t('transactions.transfer', { defaultValue: 'Transferência' }) : undefined),
    reconciled: Boolean(row.reconciled),
  }
}

export function newTransactionInputToCreate(input: NewTransactionInput): {
  account_id: string
  amount_cents: number
  type: string
  description: string
  category_id: string | null
  date: string
  reconciled: boolean
} {
  return {
    account_id: input.accountId,
    amount_cents: input.amountCents,
    type: input.type,
    description: input.description,
    category_id: input.categoryId ?? null,
    date: input.date,
    reconciled: input.reconciled ?? false,
  }
}

export function editTransactionInputToPatch(input: EditTransactionInput): {
  account_id?: string
  description?: string
  amount_cents?: number
  type?: string
  category_id?: string | null
  date?: string
  reconciled?: boolean
} {
  const out: {
    account_id?: string
    description?: string
    amount_cents?: number
    type?: string
    category_id?: string | null
    date?: string
    reconciled?: boolean
  } = {}
  if (input.accountId !== undefined) out.account_id = input.accountId
  if (input.description !== undefined) out.description = input.description
  if (input.amountCents !== undefined) out.amount_cents = input.amountCents
  if (input.type !== undefined) out.type = input.type
  if (input.categoryId !== undefined) out.category_id = input.categoryId
  if (input.date !== undefined) out.date = input.date
  if (input.reconciled !== undefined) out.reconciled = input.reconciled
  return out
}