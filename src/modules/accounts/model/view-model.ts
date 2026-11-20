// View-model da camada accounts: dinheiro sempre em BIGINT cents (RN01).
// Tipos de exibição controlados (o dono da tela alimenta via adapter);
// nenhuma lógica de negócio mora no JSX.

import { brandTokenFor } from './brand-tokens'

/** dd/MM/yyyy já formatado (idempotência da exibição). */
const BR_DATE = /^\d{2}\/\d{2}\/\d{4}$/
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/

/**
 * Formata data de extrato para a UI: ISO (`YYYY-MM-DD` do banco) → `dd/MM/yyyy`.
 * Idempotente (valor já formatado passa intacto) e tolerante a valor inesperado.
 */
export function formatStatementDate(value: string): string {
  if (BR_DATE.test(value)) return value
  const match = ISO_DATE_PREFIX.exec(value)
  if (!match) return value
  const [, year, month, day] = match
  return `${day}/${month}/${year}`
}

export type AccountType = 'checking' | 'savings' | 'investment' | 'wallet' | 'physical_cash'

export type ConnectionStatus = 'connected' | 'syncing' | 'error' | 'manual'

export type InstitutionCode =
  | 'itau'
  | 'bradesco'
  | 'santander'
  | 'bb'
  | 'nubank'
  | 'inter'
  | 'btg'
  | 'caixa'
  | 'cora'
  | 'mercadopago'
  | 'stripe'
  | 'cash'
  | 'other'

export interface InstitutionDisplay {
  code: InstitutionCode
  name: string
  compe: string
  lightBg: string
  iconInitials: string
}

// Catálogo próprio da camada real (a galeria shadcn mantém a cópia de
// exemplo dela; direção única impede acoplamento reverso).
const CATALOG: Record<InstitutionCode, Omit<InstitutionDisplay, 'code'>> = {
  itau: { name: 'Banco Itaú Unibanco', compe: '341', lightBg: brandTokenFor('itau'), iconInitials: 'IT' },
  bradesco: { name: 'Banco Bradesco', compe: '237', lightBg: brandTokenFor('bradesco'), iconInitials: 'BR' },
  santander: { name: 'Banco Santander Brasil', compe: '033', lightBg: brandTokenFor('santander'), iconInitials: 'ST' },
  bb: { name: 'Banco do Brasil', compe: '001', lightBg: brandTokenFor('bb'), iconInitials: 'BB' },
  nubank: { name: 'Nubank PJ', compe: '260', lightBg: brandTokenFor('nubank'), iconInitials: 'NU' },
  inter: { name: 'Banco Inter Empresas', compe: '077', lightBg: brandTokenFor('inter'), iconInitials: 'IN' },
  btg: { name: 'BTG Pactual Empresas', compe: '208', lightBg: brandTokenFor('btg'), iconInitials: 'BTG' },
  caixa: { name: 'Caixa Econômica Federal', compe: '104', lightBg: brandTokenFor('caixa'), iconInitials: 'CEF' },
  cora: { name: 'Cora Conta PJ', compe: '403', lightBg: brandTokenFor('cora'), iconInitials: 'CO' },
  mercadopago: { name: 'Mercado Pago Gateway', compe: '323', lightBg: brandTokenFor('mercadopago'), iconInitials: 'MP' },
  stripe: { name: 'Stripe Payments Brasil', compe: '---', lightBg: brandTokenFor('stripe'), iconInitials: 'STP' },
  cash: { name: 'Caixa Físico / Cofre', compe: '---', lightBg: brandTokenFor('cash'), iconInitials: 'CX' },
  other: { name: '', compe: '---', lightBg: brandTokenFor('other'), iconInitials: 'OU' },
}

export const INSTITUTION_CODES = Object.keys(CATALOG) as InstitutionCode[]

export function institutionInfo(code: InstitutionCode): InstitutionDisplay {
  return { code, ...CATALOG[code] }
}

export interface AccountViewItem {
  id: string
  nickname: string
  institution: InstitutionCode
  type: AccountType
  agency: string
  accountNumber: string
  accountDigit: string
  currentBalanceCents: number
  reconciledBalanceCents: number
  blockedBalanceCents: number
  isDefault: boolean
  connectionStatus: ConnectionStatus
}

export type StatementTxType = 'credit' | 'debit' | 'transfer_in' | 'transfer_out'

export type ReconciliationStatus = 'reconciled' | 'pending' | 'divergent'

export interface StatementTxView {
  id: string
  accountId: string
  date: string
  description: string
  category: string
  counterparty?: string
  amountCents: number
  type: StatementTxType
  reconciliationStatus: ReconciliationStatus
  documentNumber?: string
  hasAttachment?: boolean
}

export interface TreasuryMetricsCents {
  totalConsolidatedBalanceCents: number
  totalAvailableBalanceCents: number
  totalBlockedBalanceCents: number
  projectedInflow15DaysCents: number
  projectedOutflow15DaysCents: number
  monthYieldCDICents: number
  yieldPercentageCDI: number
  // Sem fonte real de projeção/rendimento: cartões escondem KPIs fabricados.
  hasProjections: boolean
}

// Soma inteira em cents; nunca divide nem usa float no caminho.
export function computeTreasuryMetrics(items: AccountViewItem[]): TreasuryMetricsCents {
  let consolidated = 0
  let blocked = 0
  for (const item of items) {
    if (!Number.isInteger(item.currentBalanceCents) || !Number.isInteger(item.blockedBalanceCents)) {
      throw new Error('saldos devem ser inteiros em cents (sem float)')
    }
    consolidated += item.currentBalanceCents
    blocked += item.blockedBalanceCents
  }
  return {
    totalConsolidatedBalanceCents: consolidated,
    totalAvailableBalanceCents: consolidated - blocked,
    totalBlockedBalanceCents: blocked,
    projectedInflow15DaysCents: 0,
    projectedOutflow15DaysCents: 0,
    monthYieldCDICents: 0,
    yieldPercentageCDI: 0,
    hasProjections: false,
  }
}

export interface NewBankAccountInput {
  name: string
  type: AccountType
  institution: InstitutionCode
  agency: string
  accountNumber: string
  accountDigit: string
  initialBalanceCents: number
  connectionStatus: ConnectionStatus
  isDefault: boolean
}

export interface EditBankAccountInput {
  name: string
  type: AccountType
  institution: InstitutionCode
  agency: string
  accountNumber: string
  accountDigit: string
}
