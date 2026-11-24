import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'

import { Button } from '@/components/shadcn/ui/button'
import { Skeleton } from '@/components/shadcn/ui/skeleton'

import { TransactionStats } from '@/components/shadcn/transactions/transaction-stats'
import { TransactionTable } from '@/components/shadcn/transactions/transaction-table'
import { TransactionDialog } from './TransactionDialog'
import { TransactionDetailDialog } from './TransactionDetailDialog'

import type { Transaction as GalleryTransaction } from '@/components/shadcn/transactions/transaction-types'

// hook morto removido: useTransactions não era consumido (apenas chamado)
import type { TransactionView, NewTransactionInput, EditTransactionInput } from '../model/view-model'
import type { CategoryOption } from './TransactionDialog'
import {
  transactionRowToTransactionView,
} from '../model/transactions.adapter'
import type { TransactionRow } from '../service/transactions.service'

function toGallery(tx: TransactionView): GalleryTransaction {
  return {
    id: tx.id,
    description: tx.description,
    amount: tx.amountCents / 100,
    type: tx.type,
    category: tx.categoryName ?? tx.categoryId ?? i18n.t('transactions.noCategory', { defaultValue: 'Sem categoria' }),
    account: tx.accountName ?? '',
    paymentMethod: 'pix',
    // Mapeamento explícito de status: reconciled→completed, pending→pending,
    // posted→completed (lançamento efetivado). Cancelled não existe no
    // módulo; preserva 'completed' como fallback seguro.
    status:
      tx.status === 'reconciled'
        ? 'completed'
        : tx.status === 'pending'
          ? 'pending'
          : 'completed',
    date: tx.date,
    createdAt: tx.date,
  }
}

export interface TransactionsViewProps {
  transactions?: TransactionView[]
  rows?: TransactionRow[]
  accounts?: { id: string; name: string }[]
  categories?: CategoryOption[]
  isLoading?: boolean
  error?: string | null
  onRetry?: () => void
  onCreate?: (input: NewTransactionInput) => void | Promise<void>
  onUpdate?: (id: string, input: EditTransactionInput) => void | Promise<void>
  onDelete?: (id: string) => void | Promise<void>
  onToggleStatus?: (id: string, status: TransactionView['status']) => void | Promise<void>
  className?: string
}

export function TransactionsView({
  transactions,
  rows,
  accounts = [],
  categories = [],
  isLoading = false,
  error = null,
  onRetry,
  onCreate,
  onUpdate,
  onDelete,
  onToggleStatus,
  className = '',
}: TransactionsViewProps) {
  const { t } = useTranslation()

  const views: TransactionView[] =
    transactions ??
    (rows ?? []).map((r) => transactionRowToTransactionView(r))

  const gallery = views.map(toGallery)

  const viewById = new Map(views.map((v) => [v.id, v]))

  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [selected, setSelected] = useState<TransactionView | null>(null)
  const [editing, setEditing] = useState<TransactionView | null>(null)


  function handleOpenCreate() {
    setEditing(null)
    setIsDialogOpen(true)
  }

  function handleOpenEdit(gtx: GalleryTransaction) {
    setEditing(viewById.get(gtx.id) ?? null)
    setIsDialogOpen(true)
  }

  function handleOpenDetail(gtx: GalleryTransaction) {
    setSelected(viewById.get(gtx.id) ?? null)
    setIsDetailOpen(true)
  }

  async function handleSave(data: {
    id?: string
    description: string
    amountCents: number
    amount_cents?: number
    type: 'income' | 'expense'
    date: string
    accountId: string
    account_id?: string
    categoryId: string | null
    category_id?: string | null
    reconciled: boolean
  }) {
    const amountCents = data.amountCents ?? data.amount_cents ?? 0
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error(t('common.error', { defaultValue: 'Valor deve ter no máximo 2 casas decimais.' }))
    }
    const accountId = data.accountId ?? data.account_id ?? ''
    if (!accountId) {
      throw new Error(t('transactions.missingAccount', { defaultValue: 'Selecione uma conta.' }))
    }
    const categoryId = data.categoryId ?? data.category_id ?? null
    if (data.id) {
      const patch: EditTransactionInput = {
        accountId,
        description: data.description,
        amountCents,
        type: data.type,
        date: data.date,
        categoryId,
        reconciled: data.reconciled,
      }
      await onUpdate?.(data.id, patch)
    } else {
      await onCreate?.({
        accountId,
        amountCents,
        type: data.type,
        description: data.description,
        categoryId,
        date: data.date,
        reconciled: data.reconciled,
      })
    }
  }

  async function handleDelete(id: string) {
    await onDelete?.(id)
  }

  async function handleToggleStatus(id: string, newStatus: GalleryTransaction['status']) {
    await onToggleStatus?.(id, newStatus === 'completed' ? 'reconciled' : 'pending')
  }

  if (isLoading) {
    return (
      <div className={`flex flex-col gap-4 px-4 lg:px-6 ${className}`} aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div className={`flex flex-col gap-4 px-4 lg:px-6 ${className}`}>
        <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        {onRetry && (
          <Button variant="outline" onClick={onRetry} className="min-h-11 w-fit">
            {t('common.retry', { defaultValue: 'Tentar novamente' })}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className={`flex flex-col gap-6 ${className}`}>
      <div className="flex flex-col gap-1 px-4 lg:px-6">
        <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {t('transactions.title', { defaultValue: 'Transações' })}
        </h1>
        <p className="text-xs text-muted-foreground">
          {t('transactions.subtitle', { defaultValue: 'Acompanhe o fluxo de caixa e gerencie lançamentos.' })}
        </p>
      </div>

      <TransactionStats transactions={gallery} />

      <TransactionTable
        transactions={gallery}
        onNewTransaction={handleOpenCreate}
        onSelectTransaction={handleOpenDetail}
        onEditTransaction={handleOpenEdit}
        onDeleteTransaction={(id) => void handleDelete(id)}
        onToggleStatus={(id, status) => void handleToggleStatus(id, status)}
      />

      <TransactionDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        onSave={handleSave}
        transactionToEdit={editing}
        accounts={accounts}
        categories={categories}
      />

      <TransactionDetailDialog
        transaction={selected}
        open={isDetailOpen}
        onOpenChange={setIsDetailOpen}
        onEdit={(tx) => {
          setIsDetailOpen(false)
          setEditing(tx)
          setIsDialogOpen(true)
        }}
        onToggleReconciled={(id, reconciled) => {
          void onToggleStatus?.(id, reconciled ? 'reconciled' : 'pending')
        }}
        onDelete={(id) => {
          setIsDetailOpen(false)
          void handleDelete(id)
        }}
      />
    </div>
  )
}
