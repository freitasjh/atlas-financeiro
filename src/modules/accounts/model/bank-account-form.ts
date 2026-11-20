import type { AccountType, InstitutionCode } from './view-model'
import { parseBRLToCents } from '@/lib/money'
import type { AccountCreate } from '../service/accounts.service'

// Formulário → contrato do service. Saldo entra como string BRL e sai em
// cents inteiros (RN01); nunca há float no caminho.

export interface BankAccountFormValues {
  nickname: string
  type: AccountType
  institution: InstitutionCode
  agency: string
  accountNumber: string
  accountDigit: string
  initialBalanceRaw: string
  connectionMethod: 'open_finance' | 'manual'
  isDefault: boolean
}

export type BankAccountFormError = 'name-required' | 'invalid-balance'

export type BuildAccountCreateResult =
  | { ok: true; input: AccountCreate }
  | { ok: false; error: BankAccountFormError }

export function buildAccountCreateInput(values: BankAccountFormValues): BuildAccountCreateResult {
  const name = values.nickname.trim()
  if (name === '') return { ok: false, error: 'name-required' }

  const raw = values.initialBalanceRaw.trim()
  const initialBalanceCents = raw === '' ? 0 : parseBRLToCents(raw)
  if (initialBalanceCents === null || initialBalanceCents < 0) {
    return { ok: false, error: 'invalid-balance' }
  }

  return {
    ok: true,
    input: {
      name,
      type: values.type,
      initial_balance_cents: initialBalanceCents,
      institution: values.institution,
      agency: values.agency.trim(),
      account_number: values.accountNumber.trim(),
      account_digit: values.accountDigit.trim(),
      is_default: values.isDefault,
      connection_status: values.connectionMethod === 'open_finance' ? 'connected' : 'manual',
    },
  }
}
