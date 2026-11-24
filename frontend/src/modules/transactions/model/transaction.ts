import { z } from 'zod'

// FE-tx — transações: model puro. RN01: BIGINT cents, int >= 0.
// Status de exibição: posted | pending | reconciled (derivado de reconciled + data).

export const TRANSACTION_TYPES = ['income', 'expense', 'transfer'] as const
export type TransactionType = (typeof TRANSACTION_TYPES)[number]

export const TRANSACTION_STATUSES = ['posted', 'pending', 'reconciled'] as const
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number]

export const transactionSchema = z.strictObject({
  account_id: z.string().uuid(),
  amount_cents: z.number().int().nonnegative(),
  type: z.enum(['income', 'expense']),
  description: z.string().trim().min(1).max(240).optional(),
  category_id: z.string().uuid().nullish(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  is_transfer: z.boolean().optional(),
  transfer_destination_account_id: z.string().uuid().nullish(),
  reconciled: z.boolean().optional(),
  installment_plan_id: z.string().uuid().nullish(),
  fitid: z.string().trim().min(1).max(64).nullish(),
  dedup_hash: z.string().trim().min(1).max(128).nullish(),
})

export type TransactionInput = z.infer<typeof transactionSchema>

export const transactionUpdateSchema = z.strictObject({
  account_id: z.string().uuid().optional(),
  is_transfer: z.boolean().optional(),
  transfer_destination_account_id: z.string().uuid().nullish().optional(),
  description: z.string().trim().min(1).max(240).optional(),
  amount_cents: z.number().int().nonnegative().optional(),
  type: z.enum(['income', 'expense']).optional(),
  category_id: z.string().uuid().nullish().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reconciled: z.boolean().optional(),
  fitid: z.string().trim().min(1).max(64).nullish().optional(),
  dedup_hash: z.string().trim().min(1).max(128).nullish().optional(),
})

export type TransactionPatchInput = z.infer<typeof transactionUpdateSchema>

// Deriva status de exibição a partir de reconciled + data.
export function deriveTransactionStatus(
  reconciled: boolean,
  date: string,
  today: string = new Date().toISOString().slice(0, 10),
): TransactionStatus {
  if (reconciled) return 'reconciled'
  if (date > today) return 'pending'
  return 'posted'
}
