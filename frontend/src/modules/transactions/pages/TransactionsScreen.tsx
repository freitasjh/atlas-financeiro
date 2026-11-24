import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/ui/alert'
import { Button } from '@/components/shadcn/ui/button'
import { Skeleton } from '@/components/shadcn/ui/skeleton'

import { TransactionsView } from '../components/TransactionsView'
import { useTransactionsStore } from '../store/transactions.store'
import { useAccountsStore } from '@/modules/accounts/store/accounts.store'
import { useCategoriesStore } from '@/modules/categories/store/categories.store'
import { transactionRowToTransactionView } from '../model/transactions.adapter'
import { newTransactionInputToCreate, editTransactionInputToPatch } from '../model/transactions.adapter'
import type { NewTransactionInput, EditTransactionInput } from '../model/view-model'

export function TransactionsScreen() {
  const { t } = useTranslation()
  const transactions = useTransactionsStore((s) => s.transactions)
  const status = useTransactionsStore((s) => s.status)
  const load = useTransactionsStore((s) => s.load)
  const create = useTransactionsStore((s) => s.create)
  const update = useTransactionsStore((s) => s.update)
  const remove = useTransactionsStore((s) => s.remove)

  const accounts = useAccountsStore((s) => s.accounts)
  const accountsStatus = useAccountsStore((s) => s.status)
  const loadAccounts = useAccountsStore((s) => s.load)

  const categories = useCategoriesStore((s) => s.categories)
  const loadCategories = useCategoriesStore((s) => s.load)

  useEffect(() => {
    void load()
    void loadAccounts()
    void loadCategories({ silent: true })
  }, [load, loadAccounts, loadCategories])

  const accountNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of accounts) map.set(a.id, a.name)
    return map
  }, [accounts])

  const views = useMemo(
    () => transactions.map((r) => transactionRowToTransactionView(r, { accountName: accountNameById.get(r.account_id) })),
    [transactions, accountNameById],
  )

  const translateError = (e: unknown): string => {
    const msg = e instanceof Error ? e.message : ''
    if (msg === 'account-negative-balance') {
      return t('accounts.balanceError', { defaultValue: 'O saldo calculado com os lançamentos ficaria negativo. Ajuste os lançamentos antes de salvar.' })
    }
    return msg || t('common.error', { defaultValue: 'Erro.' })
  }

  const handleCreate = async (input: NewTransactionInput): Promise<void> => {
    try {
      await create(newTransactionInputToCreate(input))
      toast.success(t('transactions.created', { defaultValue: 'Transação criada com sucesso.' }))
    } catch (e) {
      toast.error(translateError(e))
      throw e
    }
  }

  const handleUpdate = async (id: string, input: EditTransactionInput): Promise<void> => {
    try {
      await update(id, editTransactionInputToPatch(input))
      toast.success(t('transactions.updated', { defaultValue: 'Transação atualizada com sucesso.' }))
    } catch (e) {
      toast.error(translateError(e))
      throw e
    }
  }

  const handleDelete = async (id: string): Promise<void> => {
    try {
      await remove(id)
      toast.success(t('transactions.deleted', { defaultValue: 'Transação excluída com sucesso.' }))
    } catch (e) {
      toast.error(translateError(e))
      throw e
    }
  }

  const handleToggleStatus = async (id: string, status: 'posted' | 'pending' | 'reconciled'): Promise<void> => {
    try {
      await update(id, { reconciled: status === 'reconciled' })
    } catch (e) {
      toast.error(translateError(e))
      throw e
    }
  }

  if (status === 'loading' || status === 'idle' || accountsStatus === 'loading' || accountsStatus === 'idle') {
    return (
      <div className="flex w-full flex-col gap-4 px-4 pb-8 lg:px-6" aria-busy="true">
        <Skeleton className="h-8 w-64 rounded-md" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex w-full flex-col gap-4 px-4 pb-8 lg:px-6">
        <Alert variant="destructive">
          <AlertTitle>{t('common.error', { defaultValue: 'Erro' })}</AlertTitle>
          <AlertDescription>{t('transactions.loadError', { defaultValue: 'Não foi possível carregar as transações.' })}</AlertDescription>
        </Alert>
        <Button onClick={() => void load()} variant="outline" className="min-h-11 w-fit">
          {t('common.retry', { defaultValue: 'Tentar novamente' })}
        </Button>
      </div>
    )
  }

  return (
    <TransactionsView
      transactions={views}
      accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
      categories={categories.map((c) => ({ id: c.id, name: c.name, type: c.type }))}
      onCreate={handleCreate}
      onUpdate={handleUpdate}
      onDelete={handleDelete}
      onToggleStatus={handleToggleStatus}
    />
  )
}