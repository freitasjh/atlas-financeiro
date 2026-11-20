import { supabase } from '@/lib/supabase'
import type { Database } from '@/types/supabase'
import { transactionSchema, transactionUpdateSchema } from '../model/transaction'
import {
  computeAccountBalance,
  recalcAccount,
  AccountNegativeBalanceError,
} from '../../accounts/service/accounts.service'
import { todayLocalISO } from '../../accounts/model/account'

export class TransferInsufficientError extends Error {
  constructor() {
    super('transfer-insufficient')
    this.name = 'TransferInsufficientError'
  }
}

export interface InternalTransferResult {
  outRow: TransactionRow
  inRow: TransactionRow
  splitGroupId: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// P1 — transferência real entre contas (política B): 2 lançamentos vinculados
// por split_group_id (saída na origem + entrada no destino), reconciliados
// (Concluída, entram no saldo imediatamente), com recalc em ambas as contas.
// Bloqueia se a origem ficaria negativa: aborta antes de persistir e, se o
// recalc estourar, deleta as 2 linhas + recalcula a origem.
export async function executeInternalTransfer(
  sourceAccountId: string,
  targetAccountId: string,
  amountCents: number,
  description: string,
  date: string,
): Promise<InternalTransferResult> {
  if (!UUID_RE.test(sourceAccountId) || !UUID_RE.test(targetAccountId)) {
    throw new Error('invalid-account-id')
  }
  if (sourceAccountId === targetAccountId) {
    throw new Error('transfer-same-account')
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('transfer-invalid-amount')
  }
  if (!DATE_RE.test(date)) {
    throw new Error('transfer-invalid-date')
  }
  const desc = (description ?? '').trim()

  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')

  // Política B: aborta antes de qualquer escrita.
  const sourceBalance = await computeAccountBalance(sourceAccountId)
  if (sourceBalance - amountCents < 0) {
    throw new TransferInsufficientError()
  }

  const splitGroupId = crypto.randomUUID()

  const { data, error } = await supabase
    .from('transactions')
    .insert([
      {
        user_id: userId,
        account_id: sourceAccountId,
        amount_cents: amountCents,
        type: 'expense',
        description: desc,
        category_id: null,
        date,
        is_transfer: false,
        transfer_destination_account_id: null,
        reconciled: true,
        split_group_id: splitGroupId,
      },
      {
        user_id: userId,
        account_id: targetAccountId,
        amount_cents: amountCents,
        type: 'income',
        description: desc,
        category_id: null,
        date,
        is_transfer: false,
        transfer_destination_account_id: null,
        reconciled: true,
        split_group_id: splitGroupId,
      },
    ])
    .select('*')
  if (error) throw error
  const rows = (data ?? []) as TransactionRow[]
  if (rows.length !== 2) {
    await supabase.from('transactions').delete().eq('split_group_id', splitGroupId).eq('user_id', userId)
    throw new Error('transfer-persist-failed')
  }
  const outRow = rows.find((r) => r.account_id === sourceAccountId) ?? rows[0]
  const inRow = rows.find((r) => r.account_id === targetAccountId) ?? rows[1]

  try {
    await recalcAccount(sourceAccountId)
    await recalcAccount(targetAccountId)
  } catch (e) {
    await supabase.from('transactions').delete().eq('split_group_id', splitGroupId).eq('user_id', userId)
    // Rollback recalcula origem E destino (ignorando falha secundária),
    // para não deixar o destino estagnado com o saldo da tentativa falha.
    for (const accountId of [sourceAccountId, targetAccountId]) {
      try {
        await recalcAccount(accountId)
      } catch {
        // ignora falha secundária de restauração
      }
    }
    if (e instanceof AccountNegativeBalanceError) {
      throw new TransferInsufficientError()
    }
    throw e
  }

  return { outRow, inRow, splitGroupId }
}

export type TransactionRow = Database['public']['Tables']['transactions']['Row']

export interface TransactionCreate {
  account_id: string
  amount_cents: number
  type: string
  description?: string
  category_id?: string | null
  date: string
  is_transfer?: boolean
  transfer_destination_account_id?: string | null
  reconciled?: boolean
  installment_plan_id?: string | null
}

export interface TransactionUpdate {
  account_id?: string
  is_transfer?: boolean
  transfer_destination_account_id?: string | null
  description?: string
  amount_cents?: number
  type?: string
  category_id?: string | null
  date?: string
  reconciled?: boolean
}

export interface ListTransactionsOptions {
  page?: number
  pageSize?: number
  search?: string
  type?: string
  status?: string
  from?: string
  to?: string
}

export { AccountNegativeBalanceError }

function uniqueIds(ids: Array<string | null | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (!id) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export async function listTransactions(
  options?: ListTransactionsOptions,
): Promise<{ rows: TransactionRow[]; count: number }> {
  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')

  const page = options?.page ?? 1
  const pageSize = options?.pageSize ?? 50
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  let query = supabase.from('transactions').select('*', { count: 'exact' }).eq('user_id', userId)

  if (options?.type && options.type !== 'all') {
    query = query.eq('type', options.type)
  }
  if (options?.from) query = query.gte('date', options.from)
  if (options?.to) query = query.lte('date', options.to)
  if (options?.search) {
    query = query.ilike('description', `%${options.search}%`)
  }

  const { data, error, count } = await query
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) throw error
  let rows = (data ?? []) as TransactionRow[]

  // status filter aplicado no cliente (derivado de reconciled + data)
  if (options?.status && options.status !== 'all') {
    rows = rows.filter((r) => {
      const status = r.reconciled
        ? 'reconciled'
        : r.date > new Date().toISOString().slice(0, 10)
          ? 'pending'
          : 'posted'
      return status === options.status
    })
  }

  return { rows, count: count ?? rows.length }
}

// alias simples
export async function listAllTransactions(): Promise<TransactionRow[]> {
  const { rows } = await listTransactions({ pageSize: 1000 })
  return rows
}

export async function createTransaction(input: TransactionCreate): Promise<TransactionRow> {
  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')

  const parsed = transactionSchema.parse({
    account_id: input.account_id,
    amount_cents: input.amount_cents,
    type: input.type === 'income' ? 'income' : 'expense',
    description: input.description ?? '',
    category_id: input.category_id ?? null,
    date: input.date,
    is_transfer: input.is_transfer ?? false,
    transfer_destination_account_id: input.transfer_destination_account_id ?? null,
    reconciled: input.reconciled ?? false,
    installment_plan_id: input.installment_plan_id ?? null,
  })

  const { data, error } = await supabase
    .from('transactions')
    .insert({
      user_id: userId,
      account_id: parsed.account_id,
      amount_cents: parsed.amount_cents,
      type: parsed.type,
      description: parsed.description ?? '',
      category_id: parsed.category_id ?? null,
      date: parsed.date,
      is_transfer: parsed.is_transfer ?? false,
      transfer_destination_account_id: parsed.transfer_destination_account_id ?? null,
      reconciled: parsed.reconciled ?? false,
      installment_plan_id: parsed.installment_plan_id ?? null,
    })
    .select('*')
    .single()
  if (error) throw error
  const row = data as TransactionRow

  const affected = uniqueIds([
    parsed.account_id,
    parsed.is_transfer ? parsed.transfer_destination_account_id : null,
  ])

  try {
    for (const acc of affected) {
      await recalcAccount(acc)
    }
  } catch (e) {
    // Rollback: remove o lançamento recém-criado para não deixar estado inconsistente.
    const { error: delErr } = await supabase.from('transactions').delete().eq('id', row.id).eq('user_id', userId)
    if (delErr) {
      console.error('createTransaction rollback delete failed', delErr)
    }
    // Recalcula contas afetadas para restaurar estado consistente.
    for (const acc of affected) {
      try {
        await recalcAccount(acc)
      } catch {
        // ignora falha secundária
      }
    }
    throw e
  }

  return row
}

export async function updateTransaction(id: string, patch: TransactionUpdate): Promise<TransactionRow> {
  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')

  // Snapshot anterior para rollback e detecção de contas afetadas.
  const { data: oldData, error: oldErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .single()
  if (oldErr) throw oldErr
  const old = oldData as TransactionRow

  const candidate: Record<string, unknown> = {}
  if (patch.account_id !== undefined) candidate.account_id = patch.account_id
  if (patch.is_transfer !== undefined) candidate.is_transfer = patch.is_transfer
  if (patch.transfer_destination_account_id !== undefined) candidate.transfer_destination_account_id = patch.transfer_destination_account_id
  if (patch.description !== undefined) candidate.description = patch.description
  if (patch.amount_cents !== undefined) candidate.amount_cents = patch.amount_cents
  if (patch.type !== undefined) candidate.type = patch.type
  if (patch.category_id !== undefined) candidate.category_id = patch.category_id
  if (patch.date !== undefined) candidate.date = patch.date
  if (patch.reconciled !== undefined) candidate.reconciled = patch.reconciled

  const safe = transactionUpdateSchema.parse(candidate)

  const newAccountId = patch.account_id ?? old.account_id
  const newIsTransfer = patch.is_transfer ?? Boolean(old.is_transfer)
  const newDest = newIsTransfer
    ? patch.transfer_destination_account_id === undefined
      ? old.transfer_destination_account_id
      : patch.transfer_destination_account_id
    : null
  const oldAffected = uniqueIds([
    old.account_id,
    old.is_transfer ? old.transfer_destination_account_id : null,
  ])
  const newAffected = uniqueIds([newAccountId, newDest])
  const affected = uniqueIds([...oldAffected, ...newAffected])

  const { data, error } = await supabase
    .from('transactions')
    .update(safe)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) throw error
  const row = data as TransactionRow

  try {
    for (const acc of affected) {
      await recalcAccount(acc)
    }
  } catch (e) {
    // Rollback do lançamento para o estado anterior.
    const revert: Record<string, unknown> = {
      account_id: old.account_id,
      is_transfer: old.is_transfer,
      transfer_destination_account_id: old.transfer_destination_account_id,
      description: old.description,
      amount_cents: old.amount_cents,
      type: old.type,
      category_id: old.category_id,
      date: old.date,
      reconciled: old.reconciled,
      installment_plan_id: old.installment_plan_id,
    }
    const { error: revertErr } = await supabase.from('transactions').update(revert).eq('id', id).eq('user_id', userId)
    if (revertErr) {
      console.error('updateTransaction rollback update failed', revertErr)
    }
    for (const acc of affected) {
      try {
        await recalcAccount(acc)
      } catch {
        // ignora falha secundária de reconciliação
      }
    }
    throw e
  }

  return row
}

export async function deleteTransaction(id: string): Promise<void> {
  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')

  const { data: oldData, error: oldErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (oldErr) throw oldErr
  const old = (oldData ?? null) as TransactionRow | null

  const { error } = await supabase.from('transactions').delete().eq('id', id).eq('user_id', userId)
  if (error) throw error

  if (!old) return

  const affected = uniqueIds([
    old.account_id,
    old.is_transfer ? old.transfer_destination_account_id : null,
  ])

  try {
    for (const acc of affected) {
      await recalcAccount(acc)
    }
  } catch (e) {
    // Restaura o lançamento excluído para não deixar estado inconsistente.
    const { id: _id, created_at: _ca, updated_at: _ua, ...rest } = old as TransactionRow & {
      created_at?: string
      updated_at?: string
    }
    const { error: restoreErr } = await supabase.from('transactions').insert({ ...rest, id: old.id, user_id: userId })
    if (restoreErr) {
      console.error('deleteTransaction rollback restore failed', restoreErr)
    }
    for (const acc of affected) {
      try {
        await recalcAccount(acc)
      } catch {
        // ignora
      }
    }
    throw e
  }
}

export async function setTransactionReconciled(id: string, reconciled: boolean): Promise<void> {
  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')

  const { data: oldData, error: oldErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (oldErr) throw oldErr
  const old = (oldData ?? null) as TransactionRow | null
  if (!old) throw new Error('transaction-not-found')

  const { error } = await supabase
    .from('transactions')
    .update({ reconciled })
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error

  if (old.reconciled === reconciled) return

  // Recalcula apenas quando o lançamento afeta o saldo derivado (Concluída
  // e com impacto em caixa). Conciliação de lançamento futuro ou de compra
  // de cartão não altera o saldo.
  const asOf = todayLocalISO()
  const affectsBalance =
    old.date <= asOf &&
    (old.is_transfer || old.invoice_id == null) &&
    old.amount_cents > 0
  if (!affectsBalance) return

  const affected = uniqueIds([
    old.account_id,
    old.is_transfer ? old.transfer_destination_account_id : null,
  ])

  try {
    for (const acc of affected) {
      await recalcAccount(acc)
    }
  } catch (e) {
    const { error: revertErr } = await supabase
      .from('transactions')
      .update({ reconciled: old.reconciled })
      .eq('id', id)
      .eq('user_id', userId)
    if (revertErr) {
      console.error('setTransactionReconciled rollback update failed', revertErr)
    }
    for (const acc of affected) {
      try {
        await recalcAccount(acc)
      } catch {
        // ignora falha secundária
      }
    }
    throw e
  }
}