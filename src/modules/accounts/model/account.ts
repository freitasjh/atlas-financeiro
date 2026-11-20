import { z } from 'zod'

// FE-20 — contas: model puro. RN01: BIGINT cents, int >= 0.
// Saldo derivado via recalc; current_balance NUNCA entra no input.

export const ACCOUNT_TYPES = ['checking', 'savings', 'cash', 'investment', 'wallet', 'physical_cash'] as const

export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const accountSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  initial_balance_cents: z.number().int().nonnegative(),
  color: z.string().trim().max(32).nullish(),
  institution: z.string().trim().max(32).nullish(),
  agency: z.string().trim().max(16).nullish(),
  account_number: z.string().trim().max(32).nullish(),
  account_digit: z.string().trim().max(2).nullish(),
  is_default: z.boolean().optional(),
  connection_status: z.enum(['connected', 'syncing', 'error', 'manual']).optional(),
})

export type AccountInput = z.infer<typeof accountSchema>

// Patch de edição: só colunas editáveis; saldo nunca entra (derivado por recalc).
export const accountUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  institution: z.string().trim().max(32).nullish(),
  agency: z.string().trim().max(16).nullish(),
  account_number: z.string().trim().max(32).nullish(),
  account_digit: z.string().trim().max(2).nullish(),
})

export type AccountPatchInput = z.infer<typeof accountUpdateSchema>

export function recalcAccountBalance(initialBalanceCents: number, deltasCents: number[]): number {
  if (!Number.isInteger(initialBalanceCents) || initialBalanceCents < 0) {
    throw new Error('initial_balance_cents deve ser inteiro >= 0')
  }
  let total = initialBalanceCents
  for (const d of deltasCents) {
    if (!Number.isInteger(d)) throw new Error('delta deve ser inteiro em cents (sem float)')
    total += d
  }
  return total
}

export interface TxDeltaRow {
  account_id: string
  amount_cents: number
  // BG-52/D3 — fonte única de direção: transactions.type (não categories.type).
  type: 'income' | 'expense'
  is_transfer: boolean
  transfer_destination_account_id: string | null
  // MOD-07 / F2 — compra no cartão (invoice_id != null, não-transfer) não é caixa.
  invoice_id?: string | null
  // BG-55/D6 — data do lançamento: só Concluída (date <= hoje) soma no saldo.
  date: string
}

// BG-55 — hoje local YYYY-MM-DD (default do filtro de saldo; Agendada = date > hoje).
export function todayLocalISO(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// Direção do delta p/ conta A (cents >= 0 no banco, sinal aqui):
// - transfer com origem A → −; destino A → +
// - não-transfer type income → +; expense → −
// BG-55/D6 — só Concluída soma: date > asOf (default hoje local) é ignorada.
export function deltasForAccount(rows: TxDeltaRow[], accountId: string, asOf = todayLocalISO()): number[] {
  const out: number[] = []
  for (const r of rows) {
    if (!Number.isInteger(r.amount_cents) || r.amount_cents < 0) {
      throw new Error('amount_cents deve ser inteiro >= 0')
    }
    if (r.date > asOf) continue
    if (r.is_transfer) {
      if (r.account_id === accountId) out.push(-r.amount_cents)
      else if (r.transfer_destination_account_id === accountId) out.push(r.amount_cents)
      continue
    }
    // MOD-07 / F2 — compra de cartão não debita o caixa da conta pagadora.
    if (r.invoice_id != null) continue
    if (r.account_id !== accountId) continue
    out.push(r.type === 'income' ? r.amount_cents : -r.amount_cents)
  }
  return out
}

// DX-01 — reexporta o formatador canônico (sem implementação própria).
export { formatCentsBRL } from '@/lib/utils'
