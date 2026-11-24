// View-model da camada transactions: dinheiro sempre em BIGINT cents (RN01).
// Tipos de exibição controlados; nenhuma lógica de negócio mora no JSX.
// status é DERIVADO de reconciled + date (não persistido).

import type { TransactionType, TransactionStatus } from './transaction'

export interface TransactionView {
  id: string
  accountId: string
  categoryId: string | null
  date: string
  amountCents: number
  description: string
  type: TransactionType
  status: TransactionStatus
  installmentPlanId: string | null
  accountName?: string
  categoryName?: string
  reconciled?: boolean
}

export interface NewTransactionInput {
  accountId: string
  amountCents: number
  type: 'income' | 'expense'
  description: string
  categoryId?: string | null
  date: string
  reconciled?: boolean
}

export interface EditTransactionInput {
  accountId?: string
  description?: string
  amountCents?: number
  type?: 'income' | 'expense'
  categoryId?: string | null
  date?: string
  reconciled?: boolean
}