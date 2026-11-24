import { supabase } from '@/lib/supabase'
import type { Database } from '@/types/supabase'
import {
  creditCardInputToInsert,
  creditCardSchemaIdentity,
  creditCardUpdateSchema,
  type CreditCardInput,
  type CreditCardUpdateInput,
  type CreditCardView,
} from '../model/credit-card'
import { routeInvoice } from '../model/invoice-routing'
import { addMonthsISO, splitInstallments } from '../model/installments'

// C1.2 — service cartões via supabase-js (único client).
// RLS user_id em todas as leituras/escritas. Cliente NUNCA escreve
// total_cents/paid_cents/status/paid_at (só RPC/servidor — RF03 0011/0014/0015).

export type CreditCardRow = Database['public']['Tables']['credit_cards']['Row']
export type InvoiceRow = Database['public']['Tables']['invoices']['Row']

function typedError(name: string, code: string): Error {
  const error = new Error(code)
  error.name = name
  return error
}

export class CardHasHistoryError extends Error {
  constructor() {
    super('card-has-history')
    this.name = 'CardHasHistoryError'
  }
}

export class InvoiceNotFoundError extends Error {
  constructor() {
    super('invoice-not-found')
    this.name = 'InvoiceNotFoundError'
  }
}

export class InvoiceAlreadyPaidError extends Error {
  constructor() {
    super('invoice-already-paid')
    this.name = 'InvoiceAlreadyPaidError'
  }
}

export class InvoiceNothingToPayError extends Error {
  constructor() {
    super('invoice-nothing-to-pay')
    this.name = 'InvoiceNothingToPayError'
  }
}

export class InvoiceTenantMismatchError extends Error {
  constructor() {
    super('invoice-tenant-mismatch')
    this.name = 'InvoiceTenantMismatchError'
  }
}

export class InvoicePaidLockedError extends Error {
  constructor() {
    super('invoice-paid-locked')
    this.name = 'InvoicePaidLockedError'
  }
}

export class AccountNotFoundError extends Error {
  constructor() {
    super('account-not-found')
    this.name = 'AccountNotFoundError'
  }
}

export class CardNotFoundError extends Error {
  constructor() {
    super('card-not-found')
    this.name = 'CardNotFoundError'
  }
}

async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser()
  const userId = data?.user?.id
  if (!userId) throw typedError('UnauthenticatedError', 'unauthenticated')
  return userId
}

function supabaseMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return ''
}

export async function listCreditCards(): Promise<CreditCardRow[]> {
  const { data, error } = await supabase.from('credit_cards').select('*').order('name')
  if (error) throw error
  return (data ?? []) as CreditCardRow[]
}

export async function createCreditCard(input: CreditCardInput): Promise<CreditCardRow> {
  const userId = await requireUserId()
  const insert = creditCardInputToInsert(creditCardSchemaIdentity.parse(input), userId)
  const { data, error } = await supabase.from('credit_cards').insert(insert).select('*').single()
  if (error) throw error
  return data as CreditCardRow
}

export async function updateCreditCard(id: string, patch: CreditCardUpdateInput): Promise<CreditCardRow> {
  const userId = await requireUserId()
  // brand é view-only: descartada antes do update; total/paid/status nem existem no schema.
  const { brand: _brand, ...rest } = creditCardUpdateSchema.parse(patch)
  void _brand
  const { data, error } = await supabase
    .from('credit_cards')
    .update(rest)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) throw error
  return data as CreditCardRow
}

export async function deleteCreditCard(id: string): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase.from('credit_cards').delete().eq('id', id).eq('user_id', userId)
  if (error) {
    // 0015/0016: exclusão com histórico é recusada no banco, sem cascade silencioso.
    if (supabaseMessage(error).includes('card-has-history')) throw new CardHasHistoryError()
    throw error
  }
}

// ADR-002: promoção de cartão principal via RPC — 1 round-trip. O cliente
// nunca monta as duas UPDATEs; a RPC valida o dono e troca atomicamente.
export async function setDefaultCard(id: string): Promise<void> {
  const { error } = await supabase.rpc('set_default_card', { p_card_id: id })
  if (error) {
    if (supabaseMessage(error).includes('card-not-found')) throw new CardNotFoundError()
    throw error
  }
}

export async function listInvoicesByCard(cardId: string): Promise<InvoiceRow[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('credit_card_id', cardId)
    .order('period_start', { ascending: false })
  if (error) throw error
  return (data ?? []) as InvoiceRow[]
}

export interface PayInvoiceInput {
  invoiceId: string
  accountId: string
  // YYYY-MM-DD: a RPC calcula o valor no servidor (transacional, atômica).
  date: string
}

// Pagamento via RPC pay_invoice (0012): trava a fatura FOR UPDATE, calcula o
// devedor no servidor e insere a transferência + marca paid na mesma transação.
// O cliente nunca monta o valor.
export async function payInvoice(input: PayInvoiceInput): Promise<string> {
  const { data, error } = await supabase.rpc('pay_invoice', {
    p_invoice: input.invoiceId,
    p_account: input.accountId,
    p_date: input.date,
  })
  if (error) {
    const message = supabaseMessage(error)
    if (message.includes('invoice-nothing-to-pay')) throw new InvoiceNothingToPayError()
    if (message.includes('invoice-already-paid')) throw new InvoiceAlreadyPaidError()
    if (message.includes('invoice-tenant-mismatch')) throw new InvoiceTenantMismatchError()
    if (message.includes('invoice-paid-locked')) throw new InvoicePaidLockedError()
    if (message.includes('invoice-not-found')) throw new InvoiceNotFoundError()
    if (message.includes('account-not-found')) throw new AccountNotFoundError()
    throw error
  }
  return data as string
}

// P1 — compra de cartão (RN02/RN03). Dinheiro só em BIGINT cents; nenhuma
// escrita de total_cents/status/paid_cents pelo cliente (0014/0015).
export type TransactionRow = Database['public']['Tables']['transactions']['Row']

export type PurchaseCard = Pick<CreditCardRow, 'id' | 'account_id' | 'closing_day' | 'due_day'>

// A1 — adapter: a View usa camelCase; o banco, snake_case. Aceita também a Row
// do store sem conversão.
export function creditCardViewToPurchaseCard(card: CreditCardView | PurchaseCard): PurchaseCard {
  if ('closing_day' in card) {
    return {
      id: card.id,
      account_id: card.account_id,
      closing_day: card.closing_day,
      due_day: card.due_day,
    }
  }
  return {
    id: card.id,
    account_id: card.accountId,
    closing_day: card.closingDay,
    due_day: card.dueDay,
  }
}

// A2 — distinta de InvoicePaidLockedError (payInvoice: 'invoice-paid-locked',
// sem id). Esta nasce do guard de INSERT 0009 e carrega o id da fatura.
export class PurchaseInvoicePaidError extends Error {
  readonly invoiceId: string

  constructor(invoiceId: string) {
    super('invoice-already-paid')
    this.name = 'PurchaseInvoicePaidError'
    this.invoiceId = invoiceId
  }
}

// A3 — FK transactions.category_id não aplica RLS: o service valida o tenant
// antes de provisionar fatura/plano (fail-closed inclusive em erro de rede).
export class CategoryTenantMismatchError extends Error {
  constructor() {
    super('category-tenant-mismatch')
    this.name = 'CategoryTenantMismatchError'
  }
}

export class InvoiceCardMismatchError extends Error {
  constructor() {
    super('invoice-card-mismatch')
    this.name = 'InvoiceCardMismatchError'
  }
}

export interface CardPurchaseInput {
  description: string
  totalCents: number
  date: string
  categoryId?: string | null
  /** Fora da UI (A5): alocação retroativa explícita; validada contra o cartão. */
  targetInvoiceId?: string | null
  competenceNote?: string | null
}

export interface InstallmentPurchaseInput {
  description: string
  totalCents: number
  count: number
  firstDate: string
  categoryId?: string | null
  competenceNote?: string | null
}

interface CleanupFailure {
  table: string
  error: unknown
}

function assertISODate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('data deve ser YYYY-MM-DD')
}

function assertPurchaseInput(description: string, totalCents: number): void {
  if (description.trim() === '') throw new Error('description obrigatória')
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error('total deve ser inteiro >= 0 em cents (sem float)')
  }
}

export async function assertCategoryBelongsToTenant(
  categoryId: string | null | undefined,
  userId: string,
): Promise<void> {
  if (!categoryId) return
  const { data, error } = await supabase
    .from('categories')
    .select('id')
    .eq('id', categoryId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new CategoryTenantMismatchError()
}

export function mapInvoiceGuardError(error: unknown, invoiceId: string): Error {
  const message = supabaseMessage(error)
  if (message.includes('invoice-paid-locked')) return new PurchaseInvoicePaidError(invoiceId)
  if (message.includes('invoice-tenant-mismatch')) return new InvoiceTenantMismatchError()
  if (message.includes('category-tenant-mismatch')) return new CategoryTenantMismatchError()
  return error instanceof Error ? error : new Error(message)
}

// supabase-js não lança em erro de query: toda compensação checa `{ error }`.
// Falha na compensação preserva o erro original (cause) e nomeia a tabela suja.
function compensationFailed(original: unknown, failures: CleanupFailure[]): Error {
  const base = original instanceof Error ? original : new Error(supabaseMessage(original))
  if (failures.length === 0) return base
  const detail = failures.map((failure) => `${failure.table}: ${supabaseMessage(failure.error)}`).join('; ')
  const aggregated = new Error(`${base.message} (compensação falhou — ${detail})`)
  aggregated.name = base.name
  aggregated.cause = base
  return aggregated
}

export async function getInvoiceById(invoiceId: string, userId: string): Promise<InvoiceRow | null> {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return (data as InvoiceRow | null) ?? null
}

async function findInvoiceForCycle(
  cardId: string,
  userId: string,
  periodStart: string,
): Promise<InvoiceRow | null> {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('credit_card_id', cardId)
    .eq('period_start', periodStart)
    .eq('user_id', userId)
  if (error) throw error
  const rows = (data ?? []) as InvoiceRow[]
  return rows[0] ?? null
}

// Fatura lazy: select → insert (nunca upsert — fatura existente não é mutada).
// Corrida no UNIQUE(card,period_start) (23505) → re-select da vencedora.
export async function ensureInvoiceForPurchase(
  card: Pick<CreditCardRow, 'id' | 'closing_day' | 'due_day'>,
  purchaseDate: string,
): Promise<InvoiceRow> {
  const cycle = routeInvoice(purchaseDate, card.closing_day, card.due_day)
  const userId = await requireUserId()
  const existing = await findInvoiceForCycle(card.id, userId, cycle.period_start)
  if (existing) return existing

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      credit_card_id: card.id,
      period_start: cycle.period_start,
      period_end: cycle.period_end,
      due_date: cycle.due_date,
      status: 'open',
    })
    .select('*')
    .single()
  if (!error) return data as InvoiceRow

  if ((error as { code?: string }).code === '23505') {
    const winner = await findInvoiceForCycle(card.id, userId, cycle.period_start)
    if (winner) return winner
  }
  throw error
}

export async function recalcInvoiceTotal(invoiceId: string): Promise<number> {
  const { data, error } = await supabase.rpc('recalc_invoice_total', { p_invoice: invoiceId })
  if (error) throw error
  // NULL = fatura inexistente ou de outro tenant (0014): nunca tratar como 0.
  if (data === null || data === undefined) throw new InvoiceNotFoundError()
  const total = typeof data === 'number' ? data : Number(data)
  if (!Number.isInteger(total) || total < 0) {
    throw new Error('total deve ser inteiro >= 0 em cents (sem float)')
  }
  return total
}

export async function createCardPurchase(
  card: CreditCardView | PurchaseCard,
  input: CardPurchaseInput,
): Promise<TransactionRow> {
  assertPurchaseInput(input.description, input.totalCents)
  assertISODate(input.date)
  const purchaseCard = creditCardViewToPurchaseCard(card)
  const userId = await requireUserId()
  await assertCategoryBelongsToTenant(input.categoryId, userId)

  const invoice = input.targetInvoiceId
    ? await getInvoiceById(input.targetInvoiceId, userId)
    : await ensureInvoiceForPurchase(purchaseCard, input.date)
  if (!invoice) throw new InvoiceNotFoundError()
  if (invoice.credit_card_id !== purchaseCard.id) throw new InvoiceCardMismatchError()

  const note = input.competenceNote?.trim() ?? ''
  const description = note ? `${input.description.trim()} · ${note}` : input.description.trim()
  const { data, error } = await supabase
    .from('transactions')
    .insert({
      user_id: userId,
      account_id: purchaseCard.account_id,
      invoice_id: invoice.id,
      category_id: input.categoryId ?? null,
      installment_plan_id: null,
      installment_number: null,
      description,
      amount_cents: input.totalCents,
      date: input.date,
      type: 'expense',
      is_transfer: false,
    })
    .select('*')
    .single()
  if (error) throw mapInvoiceGuardError(error, invoice.id)
  const row = data as TransactionRow

  try {
    await recalcInvoiceTotal(invoice.id)
  } catch (error) {
    const { error: undoError } = await supabase.from('transactions').delete().eq('id', row.id)
    if (undoError) throw compensationFailed(error, [{ table: 'transactions', error: undoError }])
    throw error
  }
  return row
}

export async function createInstallmentPurchase(
  card: CreditCardView | PurchaseCard,
  input: InstallmentPurchaseInput,
): Promise<{ planId: string; rows: TransactionRow[] }> {
  assertPurchaseInput(input.description, input.totalCents)
  assertISODate(input.firstDate)
  const schedule = splitInstallments(input.totalCents, input.count)
  const purchaseCard = creditCardViewToPurchaseCard(card)
  const userId = await requireUserId()
  await assertCategoryBelongsToTenant(input.categoryId, userId)

  const { data: plan, error: planError } = await supabase
    .from('installment_plans')
    .insert({
      user_id: userId,
      description: input.description.trim(),
      total_amount_cents: input.totalCents,
      total_installments: input.count,
    })
    .select('id')
    .single()
  if (planError) throw planError
  const planId = (plan as { id: string }).id

  const note = input.competenceNote?.trim() ?? ''
  const described = (index: number): string => {
    const base = `${input.description.trim()} ${index + 1}/${schedule.length}`
    return note ? `${base} · ${note}` : base
  }

  const rows: TransactionRow[] = []
  const insertedIds: string[] = []
  const invoiceIds = new Set<string>()
  try {
    for (let index = 0; index < schedule.length; index += 1) {
      const date = addMonthsISO(input.firstDate, index)
      const invoice = await ensureInvoiceForPurchase(purchaseCard, date)
      invoiceIds.add(invoice.id)
      const { data, error } = await supabase
        .from('transactions')
        .insert({
          user_id: userId,
          account_id: purchaseCard.account_id,
          invoice_id: invoice.id,
          category_id: input.categoryId ?? null,
          installment_plan_id: planId,
          installment_number: index + 1,
          description: described(index),
          amount_cents: schedule[index],
          date,
          type: 'expense',
          is_transfer: false,
        })
        .select('*')
        .single()
      if (error) throw mapInvoiceGuardError(error, invoice.id)
      const row = data as TransactionRow
      insertedIds.push(row.id)
      rows.push(row)
      await recalcInvoiceTotal(invoice.id)
    }
  } catch (error) {
    const failures: CleanupFailure[] = []
    // Linhas antes do plano: apagar o plano com linhas ainda vivas dispara
    // plan-has-history (0017). Cada delete é checado — supabase-js não lança.
    if (insertedIds.length > 0) {
      const { error: rowsError } = await supabase.from('transactions').delete().in('id', insertedIds)
      if (rowsError) failures.push({ table: 'transactions', error: rowsError })
    }
    const { error: planDeleteError } = await supabase
      .from('installment_plans')
      .delete()
      .eq('id', planId)
    if (planDeleteError) failures.push({ table: 'installment_plans', error: planDeleteError })
    // A4 — faturas vazias residuais NÃO são deletadas: UNIQUE(card,period_start)
    // reaproveita a fatura na próxima compra do mesmo ciclo (idempotente).
    for (const invoiceId of invoiceIds) {
      try {
        await recalcInvoiceTotal(invoiceId)
      } catch {
        // best-effort: preserva o erro original da compra
      }
    }
    throw compensationFailed(error, failures)
  }
  return { planId, rows }
}
