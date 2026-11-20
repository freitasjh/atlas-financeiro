import { z } from 'zod'
import type { Database } from '@/types/supabase'

// C1.1 — model cartões: zod + adapter Row↔View + status + veredito.
// Dinheiro: BIGINT cents, int, sem float. Bandeira é view-only (BIN detect
// na UI) e nunca persiste: DDL real de credit_cards não tem coluna brand
// (id, user_id, account_id, name, limit_cents, closing_day, due_day).

export const CARD_BRANDS = ['visa', 'mastercard', 'amex', 'elo', 'hipercard', 'other'] as const

export type CardBrand = (typeof CARD_BRANDS)[number]

// ADR-003 (T-01/T-02): vocabulário fechado de temas. Mesmos 5 valores do CHECK
// do banco (ADR-001); z.enum cobre o gap do `supabase gen types`, que devolve
// `string` para coluna CHECK. Nenhum literal de tema fora desta constante.
export const CARD_THEMES = ['midnight', 'emerald', 'violet', 'platinum', 'rose_gold'] as const

export const CardThemeSchema = z.enum(CARD_THEMES)

export type CardTheme = z.infer<typeof CardThemeSchema>

export const DEFAULT_CARD_THEME: CardTheme = 'platinum'

// ADR-001: o Row gerado já traz as 5 colunas de identidade. Mantemos as novas
// colunas opcionais no tipo para aceitar linhas legadas (sem backfill — ADR-005).
type GeneratedCreditCardRow = Database['public']['Tables']['credit_cards']['Row']

export type CreditCardRow = Omit<
  GeneratedCreditCardRow,
  'last4' | 'holder_name' | 'expiry_mm_aa' | 'theme' | 'is_default'
> & {
  last4?: string | null
  holder_name?: string | null
  expiry_mm_aa?: string | null
  theme?: string | null
  is_default?: boolean | null
}

export const creditCardSchema = z.strictObject({
  // apelido = credit_cards.name (trim 1-120)
  name: z.string().trim().min(1).max(120),
  // view-only: validada aqui, descartada no insert (sem coluna no banco)
  brand: z.enum(CARD_BRANDS).optional(),
  account_id: z.string().uuid(),
  limit_cents: z.number().int().positive(),
  closing_day: z.number().int().min(1).max(31),
  due_day: z.number().int().min(1).max(31),
})

// ADR-001/006: colunas de identidade PCI-safe. last4 é o ÚNICO resíduo do PAN;
// theme é validado contra o mesmo vocabulário do CHECK da 0047 (ADR-003).
// is_default NUNCA entra no schema de insert — exclusivo da RPC set_default_card.
export const creditCardIdentitySchema = z.strictObject({
  last4: z.string().regex(/^\d{4}$/).optional(),
  holder_name: z.string().trim().max(120).optional(),
  expiry_mm_aa: z.string().regex(/^(0[1-9]|1[0-2])\/\d{2}$/).optional(),
  theme: CardThemeSchema.optional(),
})

export const creditCardSchemaIdentity = creditCardSchema.merge(creditCardIdentitySchema)

// Inventário FECHADO das colunas que o cliente pode escrever no insert.
// Qualquer chave fora desta lista (number/cvv/pan/is_default) é vazamento PCI.
export const CREDIT_CARD_INSERT_KEYS = [
  'user_id',
  'account_id',
  'name',
  'limit_cents',
  'closing_day',
  'due_day',
  'last4',
  'holder_name',
  'expiry_mm_aa',
  'theme',
] as const

export class InvalidCardNumberError extends Error {
  constructor() {
    super('invalid-card-number')
    this.name = 'InvalidCardNumberError'
  }
}

// Luhn copiado como algoritmo dado da galeria (sem import — boundary spec).
export function validateLuhn(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alternate = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits.charAt(i))
    if (alternate) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    alternate = !alternate
  }
  return sum % 10 === 0
}

export function cardIdentityFromPAN(cardNumber: string): { last4: string } {
  if (!validateLuhn(cardNumber)) throw new InvalidCardNumberError()
  return { last4: cardNumber.replace(/\D/g, '').slice(-4) }
}

export type CreditCardInput = z.infer<typeof creditCardSchemaIdentity>

export const creditCardUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  brand: z.enum(CARD_BRANDS).optional(),
  account_id: z.string().uuid().optional(),
  limit_cents: z.number().int().positive(),
  closing_day: z.number().int().min(1).max(31),
  due_day: z.number().int().min(1).max(31),
})

export type CreditCardUpdateInput = z.infer<typeof creditCardUpdateSchema>

export interface CreditCardView {
  id: string
  nickname: string
  brand: CardBrand
  theme: CardTheme
  accountId: string
  limitCents: number
  closingDay: number
  dueDay: number
  // ADR-001: identidade PCI-safe. Opcionais para não quebrar View legada;
  // aliases snake_case espelham as colunas do Row para consumidores ADR-005.
  last4?: string | null
  holderName?: string | null
  expiryMmAA?: string | null
  isDefault?: boolean
  holder_name?: string | null
  expiry_mm_aa?: string | null
  is_default?: boolean
}

function validLast4(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^\d{4}$/.test(value) ? value : null
}

export function creditCardRowToView(row: CreditCardRow, brand: CardBrand = 'other'): CreditCardView {
  const parsed = CardThemeSchema.safeParse(row.theme)
  const last4 = validLast4(row.last4)
  const holderName = row.holder_name ?? null
  const expiryMmAA = row.expiry_mm_aa ?? null
  const isDefault = row.is_default === true
  return {
    id: row.id,
    nickname: row.name,
    brand,
    theme: parsed.success ? parsed.data : DEFAULT_CARD_THEME,
    accountId: row.account_id,
    limitCents: row.limit_cents,
    closingDay: row.closing_day,
    dueDay: row.due_day,
    last4,
    holderName,
    expiryMmAA,
    isDefault,
    holder_name: holderName,
    expiry_mm_aa: expiryMmAA,
    is_default: isDefault,
  }
}

// Colunas que o cliente escreve em credit_cards. Sem brand (view-only) e sem
// total/paid/status (fatura é escrita só por RPC/servidor — RF03).
export function creditCardInputToInsert(
  input: CreditCardInput,
  userId: string,
): Pick<CreditCardRow, (typeof CREDIT_CARD_INSERT_KEYS)[number]> {
  const parsed = creditCardSchemaIdentity.parse(input)
  const insert: Pick<CreditCardRow, (typeof CREDIT_CARD_INSERT_KEYS)[number]> = {
    user_id: userId,
    account_id: parsed.account_id,
    name: parsed.name,
    limit_cents: parsed.limit_cents,
    closing_day: parsed.closing_day,
    due_day: parsed.due_day,
  }
  if (parsed.last4 !== undefined) insert.last4 = parsed.last4
  if (parsed.holder_name !== undefined) insert.holder_name = parsed.holder_name
  if (parsed.expiry_mm_aa !== undefined) insert.expiry_mm_aa = parsed.expiry_mm_aa
  if (parsed.theme !== undefined) insert.theme = parsed.theme
  return insert
}

// Detecção de bandeira pelo BIN (view-only, nunca persiste).
const ELO_PREFIXES = ['4011', '431274', '438935', '451416', '457393', '457631', '457632', '504175', '506699', '5067', '509', '627780', '636297', '636368', '650']
const HIPERCARD_PREFIXES = ['606282', '637095', '637568', '637599', '637609', '637612', '38']

export function detectCardBrand(cardNumber: string): CardBrand {
  const digits = cardNumber.replace(/\D/g, '')
  if (digits.length === 0) return 'other'
  if (/^(34|37)/.test(digits)) return 'amex'
  if (HIPERCARD_PREFIXES.some((p) => digits.startsWith(p))) return 'hipercard'
  if (ELO_PREFIXES.some((p) => digits.startsWith(p))) return 'elo'
  if (/^4/.test(digits)) return 'visa'
  if (/^5[1-5]/.test(digits) || /^2[2-7]/.test(digits)) return 'mastercard'
  return 'other'
}

// Faturas: status persistido + derivado de exibição (vencto fds é display).
export const INVOICE_STATUSES = ['open', 'closed', 'partial', 'paid'] as const

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export type InvoiceDisplayStatus = 'open' | 'closed' | 'partial' | 'paid' | 'overdue'

export interface InvoiceLike {
  status: string
  total_cents: number
  paid_cents: number
  due_date: string
}

export function todayLocalISO(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// Saldo devedor com clamp em 0 (reabertura pode editar total sem invalidar o pago).
export function remainingCents(invoice: Pick<InvoiceLike, 'total_cents' | 'paid_cents'>): number {
  if (!Number.isInteger(invoice.total_cents) || !Number.isInteger(invoice.paid_cents)) {
    throw new Error('invoice cents devem ser inteiros (sem float)')
  }
  return Math.max(invoice.total_cents - invoice.paid_cents, 0)
}

export function displayInvoiceStatus(invoice: InvoiceLike, todayISO: string = todayLocalISO()): InvoiceDisplayStatus {
  if (invoice.status === 'paid') return 'paid'
  if (invoice.status === 'partial') return 'partial'
  if (invoice.status === 'closed' && invoice.due_date < todayISO) return 'overdue'
  if (invoice.status === 'closed') return 'closed'
  return 'open'
}

// Vencimento em fds é exibição apenas (SPEC §5): invoices.due_date permanece a
// nominal; o efetivo (segunda-feira) aparece na UI com chip de prorrogação.
export interface DisplayDueDate {
  nominal: string
  effective: string
  shifted: boolean
}

export function displayDueDate(dueDateISO: string): DisplayDueDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDateISO)
  if (!match) throw new Error('due_date deve ser YYYY-MM-DD')
  const base = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const weekday = base.getDay()
  const shift = weekday === 6 ? 2 : weekday === 0 ? 1 : 0
  if (shift === 0) return { nominal: dueDateISO, effective: dueDateISO, shifted: false }
  const effectiveDate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + shift)
  const pad = (n: number) => String(n).padStart(2, '0')
  const effective = `${effectiveDate.getFullYear()}-${pad(effectiveDate.getMonth() + 1)}-${pad(effectiveDate.getDate())}`
  return { nominal: dueDateISO, effective, shifted: true }
}

// RF03/RN04 guard de UI: fatura paid bloqueia edição (invoice-paid-locked no banco).
export function canEditInvoiceExpenses(status: string): boolean {
  return status !== 'paid'
}

export interface CardsVerdict {
  cardsCount: number
  totalLimitCents: number
  totalOutstandingCents: number
  openCount: number
  closedCount: number
  partialCount: number
  paidCount: number
}

// Veredito consolidado: limites somados + devedor (paid não compõe o aberto).
export function consolidatedVerdict(
  cards: Array<Pick<CreditCardRow, 'limit_cents'>>,
  invoices: InvoiceLike[],
): CardsVerdict {
  const verdict: CardsVerdict = {
    cardsCount: cards.length,
    totalLimitCents: 0,
    totalOutstandingCents: 0,
    openCount: 0,
    closedCount: 0,
    partialCount: 0,
    paidCount: 0,
  }
  for (const card of cards) {
    if (!Number.isInteger(card.limit_cents) || card.limit_cents < 0) {
      throw new Error('limit_cents deve ser inteiro >= 0')
    }
    verdict.totalLimitCents += card.limit_cents
  }
  for (const invoice of invoices) {
    switch (invoice.status) {
      case 'open':
        verdict.openCount += 1
        break
      case 'closed':
        verdict.closedCount += 1
        break
      case 'partial':
        verdict.partialCount += 1
        break
      case 'paid':
        verdict.paidCount += 1
        continue
      default:
        continue
    }
    verdict.totalOutstandingCents += remainingCents(invoice)
  }
  return verdict
}
