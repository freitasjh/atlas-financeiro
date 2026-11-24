import { supabase } from '@/lib/supabase'
import type { Database } from '@/types/supabase'
import {
  accountSchema,
  accountUpdateSchema,
  deltasForAccount,
  recalcAccountBalance,
  type TxDeltaRow,
} from '../model/account'

export type AccountRow = Database['public']['Tables']['accounts']['Row']

export interface AccountCreate {
  name: string
  type: string
  initial_balance_cents: number
  color?: string | null
  // RF-06 — campos do template BankAccountsView.
  institution?: string | null
  agency?: string | null
  account_number?: string | null
  account_digit?: string | null
  is_default?: boolean
  connection_status?: string
}

// FE-20 — service contas via supabase-js (único client).
// Nunca escreve current_balance a partir de input: seed = initial (Σ=0) ou recalc.

export async function listAccounts(): Promise<AccountRow[]> {
  const { data, error } = await supabase.from('accounts').select('*').order('name')
  if (error) throw error
  return (data ?? []) as AccountRow[]
}

export async function createAccount(input: AccountCreate): Promise<AccountRow> {
  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')

  // RN01 — validação única do contrato (BIGINT cents int >= 0) antes de escrever.
  const parsed = accountSchema.parse({
    name: input.name,
    type: input.type,
    initial_balance_cents: input.initial_balance_cents,
    color: input.color ?? null,
    institution: input.institution ?? null,
    agency: input.agency ?? null,
    account_number: input.account_number ?? null,
    account_digit: input.account_digit ?? null,
    is_default: input.is_default ?? false,
    connection_status: input.connection_status ?? 'manual',
  })

  // Conta principal é única por usuário (0045). A conta nasce SEM a flag e a
  // promoção é uma RPC transacional (0046): nunca existe janela com duas
  // principais e um insert recusado não apaga a preferência anterior.
  // Seed derivado: sem lançamentos, saldo = inicial.
  const { data, error } = await supabase
    .from('accounts')
    .insert({
      user_id: userId,
      name: parsed.name,
      type: parsed.type,
      initial_balance_cents: parsed.initial_balance_cents,
      current_balance_cents: parsed.initial_balance_cents,
      color: parsed.color ?? null,
      institution: parsed.institution ?? null,
      agency: parsed.agency ?? null,
      account_number: parsed.account_number ?? null,
      account_digit: parsed.account_digit ?? null,
      is_default: false,
      connection_status: parsed.connection_status ?? 'manual',
    })
    .select('*')
    .single()
  if (error) throw error

  const row = data as AccountRow
  if (!parsed.is_default) return row

  // Erro da promoção não é engolido: a UI informa e nada fica ambíguo.
  const { error: defaultError } = await supabase.rpc('set_default_account', {
    p_account_id: row.id,
  })
  if (defaultError) throw defaultError
  return { ...row, is_default: true }
}

export interface AccountUpdate {
  name: string
  type: string
  institution?: string | null
  agency?: string | null
  account_number?: string | null
  account_digit?: string | null
}

// Saldo projetado negativo (despesas > inicial): aborta ANTES de qualquer
// escrita. A UI traduz `accounts.balanceError`.
export class AccountNegativeBalanceError extends Error {
  constructor() {
    super('account-negative-balance')
    this.name = 'AccountNegativeBalanceError'
  }
}

function assertNonNegative(balance: number): number {
  if (balance < 0) throw new AccountNegativeBalanceError()
  return balance
}

export async function updateAccount(id: string, patch: AccountUpdate): Promise<AccountRow> {
  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')

  // current_balance/initial nunca entram no patch (saldo só via recalc).
  const candidate: Record<string, unknown> = { name: patch.name, type: patch.type }
  if (patch.institution !== undefined) candidate.institution = patch.institution
  if (patch.agency !== undefined) candidate.agency = patch.agency
  if (patch.account_number !== undefined) candidate.account_number = patch.account_number
  if (patch.account_digit !== undefined) candidate.account_digit = patch.account_digit
  const safe = accountUpdateSchema.parse(candidate)

  // Ordem atômica por falha: saldo é recalculado ANTES do update e aborta se
  // ficaria negativo — a conta não fica editada com saldo recusado pelo CHECK.
  const balance = assertNonNegative(await computeAccountBalance(id))

  const { data, error } = await supabase
    .from('accounts')
    .update(safe)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) throw error
  const row = data as AccountRow
  await writeAccountBalance(id, userId, balance)
  return { ...row, current_balance_cents: balance }
}

// 0016 — o banco recusa a exclusão quando a cascata orfanaria compras de cartão
// (`account-has-history`) ou quando o cartão da conta tem histórico
// (`card-has-history`). A mensagem crua nunca chega à UI.
export class AccountHasHistoryError extends Error {
  constructor() {
    super('account-has-history')
    this.name = 'AccountHasHistoryError'
  }
}

function describeError(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'object' && value !== null && 'message' in value) {
    return String((value as { message: unknown }).message)
  }
  return String(value)
}

export async function deleteAccount(id: string): Promise<void> {
  const { error } = await supabase.from('accounts').delete().eq('id', id)
  if (!error) return
  const message = describeError(error)
  if (message.includes('account-has-history') || message.includes('card-has-history')) {
    throw new AccountHasHistoryError()
  }
  throw error
}

interface TxRow {
  account_id: string
  amount_cents: number
  // BG-52/D3 — fonte única de direção: transactions.type (categories sai do select).
  type: string
  is_transfer: boolean
  transfer_destination_account_id: string | null
  // MOD-07 / F2 — compra de cartão identificada pelo invoice_id.
  invoice_id: string | null
  // BG-55/D6 — filtro de saldo por data (só Concluída soma).
  date: string
}

function toDeltaRow(t: TxRow): TxDeltaRow {
  return {
    account_id: t.account_id,
    amount_cents: t.amount_cents,
    type: t.type === 'income' ? 'income' : 'expense',
    is_transfer: t.is_transfer,
    transfer_destination_account_id: t.transfer_destination_account_id,
    invoice_id: t.invoice_id,
    date: t.date,
  }
}

// Fonte-verdade = initial + Σ (ADR-004). Leitura pura: nenhuma escrita.
// BG-55/D6: só Concluída (date <= asOf, default hoje local) soma; D7: exige sessão
// (nunca recalc sem userId) e escopa tudo por user_id além do RLS.
export async function computeAccountBalance(accountId: string, asOf?: string): Promise<number> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
    throw new Error('invalid-account-id')
  }
  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')
  const { data: acc, error: accErr } = await supabase
    .from('accounts')
    .select('id, initial_balance_cents')
    .eq('id', accountId)
    .eq('user_id', userId)
    .single()
  if (accErr) throw accErr
  const { data: txs, error: txErr } = await supabase
    .from('transactions')
    .select('account_id, amount_cents, type, is_transfer, transfer_destination_account_id, invoice_id, date')
    .eq('user_id', userId)
    .or(`account_id.eq.${accountId},transfer_destination_account_id.eq.${accountId}`)
  if (txErr) throw txErr
  const rows = ((txs ?? []) as unknown as TxRow[]).map(toDeltaRow)
  return recalcAccountBalance(
    (acc as { initial_balance_cents: number }).initial_balance_cents,
    deltasForAccount(rows, accountId, asOf),
  )
}

async function writeAccountBalance(accountId: string, userId: string, balance: number): Promise<void> {
  const { error } = await supabase
    .from('accounts')
    .update({ current_balance_cents: balance })
    .eq('id', accountId)
    .eq('user_id', userId)
  if (error) throw error
}

// Único escritor de current_balance. Nunca persiste saldo negativo.
export async function recalcAccount(accountId: string, asOf?: string): Promise<number> {
  const balance = assertNonNegative(await computeAccountBalance(accountId, asOf))
  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')
  await writeAccountBalance(accountId, userId, balance)
  return balance
}
