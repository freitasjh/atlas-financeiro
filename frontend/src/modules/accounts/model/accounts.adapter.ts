import i18n from '@/i18n'
import type { TFunction } from 'i18next'
import type {
  AccountType,
  AccountViewItem,
  ConnectionStatus,
  InstitutionCode,
  StatementTxView,
} from './view-model'
import { formatStatementDate, INSTITUTION_CODES } from './view-model'
import type { AccountCreate, AccountRow, AccountUpdate } from '../service/accounts.service'
import type { TransactionRow } from '../../transactions/service/transactions.service'

// Adapter de domínio: AccountRow (BIGINT cents) ↔ AccountViewItem.
// Nenhuma conversão para float: a UI formata com formatCentsBRL.

const INSTITUTION_SET = new Set<string>(INSTITUTION_CODES)

const UI_TYPE_BY_DB: Record<string, AccountType> = {
  checking: 'checking',
  savings: 'savings',
  investment: 'investment',
  wallet: 'wallet',
  physical_cash: 'physical_cash',
  cash: 'physical_cash',
}

const DB_TYPE_BY_UI: Record<AccountType, string> = {
  checking: 'checking',
  savings: 'savings',
  investment: 'investment',
  wallet: 'wallet',
  physical_cash: 'physical_cash',
}

const CONNECTION_STATUSES = new Set<ConnectionStatus>(['connected', 'syncing', 'error', 'manual'])

export function toBankInstitutionCode(value: string | null | undefined): InstitutionCode {
  if (value && INSTITUTION_SET.has(value)) return value as InstitutionCode
  return 'other'
}

export function toBankAccountType(value: string | null | undefined): AccountType {
  if (value && value in UI_TYPE_BY_DB) return UI_TYPE_BY_DB[value]
  return 'checking'
}

export function toConnectionStatus(value: string | null | undefined): ConnectionStatus {
  if (value && (CONNECTION_STATUSES as Set<string>).has(value)) {
    return value as ConnectionStatus
  }
  return 'manual'
}

export function toDbAccountType(value: AccountType): string {
  return DB_TYPE_BY_UI[value]
}

export function accountRowToBankAccount(row: AccountRow): AccountViewItem {
  const connectionStatus = toConnectionStatus(row.connection_status)
  return {
    id: row.id,
    nickname: row.name,
    institution: toBankInstitutionCode(row.institution),
    type: toBankAccountType(row.type),
    agency: row.agency ?? '---',
    accountNumber: row.account_number ?? '---',
    accountDigit: row.account_digit ?? '---',
    currentBalanceCents: row.current_balance_cents,
    reconciledBalanceCents: row.current_balance_cents,
    blockedBalanceCents: 0,
    isDefault: row.is_default,
    connectionStatus,
  }
}

export function newBankAccountInputToCreate(input: {
  name: string
  type: AccountType
  institution: InstitutionCode
  agency: string
  accountNumber: string
  accountDigit: string
  initialBalanceCents: number
  connectionStatus: ConnectionStatus
  isDefault: boolean
}): AccountCreate {
  return {
    name: input.name,
    type: toDbAccountType(input.type),
    initial_balance_cents: input.initialBalanceCents,
    institution: input.institution,
    agency: input.agency,
    account_number: input.accountNumber,
    account_digit: input.accountDigit,
    is_default: input.isDefault,
    connection_status: input.connectionStatus,
  }
}

export function editBankAccountInputToPatch(input: {
  name: string
  type: AccountType
  institution: InstitutionCode
  agency: string
  accountNumber: string
  accountDigit: string
}): AccountUpdate {
  return {
    name: input.name,
    type: toDbAccountType(input.type),
    institution: input.institution,
    agency: input.agency,
    account_number: input.accountNumber,
    account_digit: input.accountDigit,
  }
}


export function transactionRowToStatementTx(
  row: TransactionRow,
  opts?: { categoryName?: string; counterparty?: string },
): StatementTxView {
  const isTransfer = Boolean(row.is_transfer)
  const type: StatementTxView['type'] =
    row.type === 'income' || row.type === 'transfer_in'
      ? 'credit'
      : row.type === 'expense' || row.type === 'transfer_out'
        ? 'debit'
        : isTransfer
          ? 'debit'
          : 'debit'

  const reconciliationStatus: StatementTxView['reconciliationStatus'] = row.reconciled
    ? 'reconciled'
    : row.date > new Date().toISOString().slice(0, 10)
      ? 'pending'
      : 'pending'

  return {
    id: row.id,
    accountId: row.account_id,
    date: formatStatementDate(row.date),
    description:
      row.description && row.description.trim().length > 0
        ? row.description
        : i18n.t('transactions.noDescription', { defaultValue: 'Lançamento sem descrição' }),
// UUID nunca vaza para a UI: id desconhecido/pendente usa fallback honesto.
    category:
      opts?.categoryName ??
      (isTransfer
        ? i18n.t('transactions.transfer', { defaultValue: 'Transferência' })
        : i18n.t('transactions.noCategory', { defaultValue: 'Sem categoria' })),
    counterparty: opts?.counterparty,
    amountCents: row.amount_cents,
    type,
    reconciliationStatus,
    documentNumber: row.fitid ?? undefined,
  }
}

// Alias de compatibilidade (alguns callers/tests usam o nome longo).
export const transactionRowToStatementTxView = transactionRowToStatementTx

// Extrato honesto (opção B — bug contas-extrato-demo): conta nova abre vazia.
// Nenhuma linha é injetada; o adapter preserva BIGINT cents sem gerar dado.
// Mantido o export para compatibilidade: sempre retorna [].
export function demoStatementForAccounts(
  _accounts: AccountViewItem[],
  _t: TFunction,
  _today: Date = new Date(),
): StatementTxView[] {
  return []
}
