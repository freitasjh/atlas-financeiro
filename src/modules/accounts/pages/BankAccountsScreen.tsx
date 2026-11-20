import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/ui/alert'
import { Button } from '@/components/shadcn/ui/button'
import { Skeleton } from '@/components/shadcn/ui/skeleton'
import { AccountsView } from '../components/AccountsView'
import type { EditBankAccountInput, NewBankAccountInput, StatementTxView } from '../model/view-model'
import { useAccountsStore } from '../store/accounts.store'
import {
  accountRowToBankAccount,
  editBankAccountInputToPatch,
  newBankAccountInputToCreate,
  transactionRowToStatementTx,
} from '../model/accounts.adapter'
import { useTransactionsStore } from '@/modules/transactions/store/transactions.store'
import { useCategoryNames } from '../hooks/useCategoryNames'
import { executeInternalTransfer, TransferInsufficientError } from '@/modules/transactions/service/transactions.service'

// /contas alimentada pelo Supabase via store + adapter.
// Saldo trafega em BIGINT cents; a formatação acontece na exibição.

export function BankAccountsScreen() {
  const { t } = useTranslation()
  const accounts = useAccountsStore((state) => state.accounts)
  const status = useAccountsStore((state) => state.status)
  const load = useAccountsStore((state) => state.load)
  const create = useAccountsStore((state) => state.create)
  const update = useAccountsStore((state) => state.update)
  const remove = useAccountsStore((state) => state.remove)

  const transactionRows = useTransactionsStore((state) => state.transactions)
  const transactionsStatus = useTransactionsStore((state) => state.status)
  const transactionsCount = useTransactionsStore((state) => state.count)
  const loadTransactions = useTransactionsStore((state) => state.load)
  const { categoryNames, loaded: categoriesLoaded } = useCategoryNames()

  const [selectedAccountId, setSelectedAccountId] = useState('')

  useEffect(() => {
    void Promise.all([load(), loadTransactions({ pageSize: 1000, silent: true })])
  }, [load, loadTransactions])

  const bankAccounts = useMemo(() => accounts.map(accountRowToBankAccount), [accounts])

  // QA-OFX-02: resolve category_id via lookup único (mapa em memória, sem N+1).
  // Transferências nunca usam nome de categoria; fallback do adapter mantido.
  // Gate em categoriesLoaded: enquanto pendente, opts sem categoryName para o
  // adapter usar o fallback honesto (nunca UUID cru por ~1 frame).
  const adaptedTransactions = useMemo<StatementTxView[]>(
    () =>
      transactionRows.map((row) => {
        if (categoriesLoaded && !row.is_transfer && row.category_id && categoryNames.has(row.category_id)) {
          return transactionRowToStatementTx(row, {
            categoryName: categoryNames.get(row.category_id),
          })
        }
        return transactionRowToStatementTx(row)
      }),
    [transactionRows, categoryNames, categoriesLoaded],
  )

  const transactions = useMemo<StatementTxView[]>(() => {
    if (selectedAccountId === '') return adaptedTransactions
    return adaptedTransactions.filter((tx) => tx.accountId === selectedAccountId)
  }, [adaptedTransactions, selectedAccountId])

  const handleCreate = async (input: NewBankAccountInput): Promise<void> => {
    await create(newBankAccountInputToCreate(input))
    toast.success(t('accounts.toastCreated'))
    void loadTransactions({ pageSize: 1000, silent: true })
  }

  const handleUpdate = async (id: string, input: EditBankAccountInput): Promise<void> => {
    await update(id, editBankAccountInputToPatch(input))
    toast.success(t('accounts.toastUpdated'))
    void loadTransactions({ pageSize: 1000, silent: true })
  }

  const handleDelete = async (id: string): Promise<void> => {
    await remove(id)
    toast.success(t('accounts.toastRemoved'))
    void loadTransactions({ pageSize: 1000, silent: true })
  }

  // Contrato: dona do toast (sucesso/erro) e do boolean de resultado.
  // true = transferência persistida; false = falha (modal exibe erro inline).
  // Nunca relança: o modal trata false e catch sem unhandled.
  const handleExecuteTransfer = async (
    sourceAccountId: string,
    targetAccountId: string,
    amountCents: number,
    description: string,
    date: string,
  ): Promise<boolean> => {
    try {
      await executeInternalTransfer(sourceAccountId, targetAccountId, amountCents, description, date)
      toast.success(t('accounts.transferDone'))
      await Promise.all([load(), loadTransactions({ pageSize: 1000, silent: true })])
      return true
    } catch (err) {
      if (err instanceof TransferInsufficientError) {
        toast.error(t('accounts.transferInsufficient'))
      } else {
        toast.error(t('accounts.transferError'))
      }
      return false
    }
  }

  const containerClassName = 'flex w-full flex-col gap-5 px-4 pb-8 lg:px-6'

  if (status === 'loading' || status === 'idle') {
    return (
      <div className={containerClassName} aria-busy="true" aria-live="polite">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 border-b border-border/70 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-2">
              <Skeleton className="h-8 w-64 rounded-md" />
              <Skeleton className="h-4 w-80 max-w-full rounded-md" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-11 w-28 rounded-md" />
              <Skeleton className="h-11 w-28 rounded-md" />
              <Skeleton className="h-11 w-28 rounded-md" />
              <Skeleton className="h-11 w-32 rounded-md" />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <Skeleton className="h-36 w-full rounded-2xl" />
          </div>
        </div>

        <div className="flex justify-end">
          <Skeleton className="h-11 w-64 rounded-lg" />
        </div>

        <div className="flex items-center gap-2 overflow-hidden pb-2">
          <Skeleton className="h-14 w-44 shrink-0 rounded-xl" />
          <Skeleton className="h-14 w-44 shrink-0 rounded-xl" />
          <Skeleton className="h-14 w-44 shrink-0 rounded-xl" />
          <Skeleton className="h-11 w-32 shrink-0 rounded-md" />
        </div>

        <div className="flex flex-col gap-4">
          <Skeleton className="h-44 w-full rounded-2xl" />
          <Skeleton className="h-80 w-full rounded-2xl" />
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className={containerClassName}>
        <Alert variant="destructive">
          <AlertTitle>{t('common.error')}</AlertTitle>
          <AlertDescription>{t('accounts.loadError')}</AlertDescription>
        </Alert>
        <Button onClick={() => void load()} variant="outline" className="min-h-11 w-fit">
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  return (
    <AccountsView
      accounts={bankAccounts}
      transactions={transactions}
      transactionsStatus={transactionsStatus}
      transactionsTotalCount={transactionsCount}
      onRetryTransactions={() => void loadTransactions({ pageSize: 1000 })}
      selectedAccountId={selectedAccountId}
      onSelectAccount={setSelectedAccountId}
      onCreateAccount={handleCreate}
      onUpdateAccount={handleUpdate}
      onDeleteAccount={handleDelete}
      onExecuteTransfer={handleExecuteTransfer}
    />
  )
}
