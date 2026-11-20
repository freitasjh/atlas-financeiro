import { useTranslation } from 'react-i18next'
import { formatCentsBRL } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/ui/dialog'
import { Button } from '@/components/shadcn/ui/button'
import { Badge } from '@/components/shadcn/ui/badge'
import { Separator } from '@/components/shadcn/ui/separator'
import { CheckCircle2, Pencil, Trash2 } from 'lucide-react'
import type { TransactionView } from '../model/view-model'

interface TransactionDetailDialogProps {
  transaction: TransactionView | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit?: (transaction: TransactionView) => void
  onDelete?: (id: string) => void
  onToggleReconciled?: (id: string, reconciled: boolean) => void
}

function formatDate(iso: string): string {
  if (!iso) return '-'
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}/${m}/${y}`
}

export function TransactionDetailDialog({
  transaction,
  open,
  onOpenChange,
  onEdit,
  onDelete,
  onToggleReconciled,
}: TransactionDetailDialogProps) {
  const { t } = useTranslation()

  if (!transaction) return null

  const isIncome = transaction.type === 'income'
  const isExpense = transaction.type === 'expense'
  const reconciled = Boolean(transaction.reconciled ?? transaction.status === 'reconciled')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <Badge
              variant={reconciled ? 'default' : transaction.status === 'pending' ? 'secondary' : 'default'}
              className="gap-1 px-2.5 py-0.5 text-xs font-semibold"
            >
              {reconciled
                ? t('transactions.statusReconciled', { defaultValue: 'Conciliado' })
                : transaction.status === 'pending'
                  ? t('transactions.statusPending', { defaultValue: 'Pendente' })
                  : t('transactions.statusPosted', { defaultValue: 'Lançado' })}
            </Badge>
            <span className="text-xs text-muted-foreground">ID: {transaction.id}</span>
          </div>

          <div className="mt-4 flex flex-col items-center justify-center rounded-xl bg-muted/50 py-5">
            <div
              className={`flex items-center gap-1.5 text-3xl font-extrabold tracking-tight tabular-nums ${
                isIncome
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : isExpense
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-foreground'
              }`}
            >
              {formatCentsBRL(transaction.amountCents)}
            </div>
            <DialogTitle className="mt-2 text-center text-sm font-medium text-foreground">
              {transaction.description}
            </DialogTitle>
            <DialogDescription className="text-center text-xs text-muted-foreground">
              {transaction.categoryName ?? transaction.categoryId ?? t('transactions.noCategory', { defaultValue: 'Sem categoria' })}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('transactions.account', { defaultValue: 'Conta' })}</span>
            <span className="font-medium text-foreground">{transaction.accountName ?? transaction.accountId}</span>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('transactions.date', { defaultValue: 'Data' })}</span>
            <span className="font-medium text-foreground">{formatDate(transaction.date)}</span>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('transactions.type', { defaultValue: 'Tipo' })}</span>
            <span className="font-medium text-foreground">
              {transaction.type === 'income'
                ? t('transactions.income', { defaultValue: 'Receita' })
                : transaction.type === 'expense'
                  ? t('transactions.expense', { defaultValue: 'Despesa' })
                  : t('transactions.transfer', { defaultValue: 'Transferência' })}
            </span>
          </div>
          {transaction.categoryId && (
            <>
              <Separator />
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('transactions.category', { defaultValue: 'Categoria' })}</span>
                <span className="font-medium text-foreground">{transaction.categoryName ?? transaction.categoryId}</span>
              </div>
            </>
          )}
        </div>

        <DialogFooter className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            {onToggleReconciled && (
              <Button
                type="button"
                variant={reconciled ? 'outline' : 'default'}
                size="sm"
                onClick={() => {
                  onToggleReconciled(transaction.id, !reconciled)
                  onOpenChange(false)
                }}
                className="gap-1.5"
              >
                <CheckCircle2 className="size-3.5" />
                {reconciled
                  ? t('transactions.unreconcile', { defaultValue: 'Desconciliar' })
                  : t('transactions.reconcile', { defaultValue: 'Conciliar' })}
              </Button>
            )}
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                onDelete?.(transaction.id)
                onOpenChange(false)
              }}
              className="gap-1.5"
            >
              <Trash2 className="size-3.5" />
              {t('common.delete', { defaultValue: 'Excluir' })}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.close', { defaultValue: 'Fechar' })}
            </Button>
            {onEdit && (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  onEdit(transaction)
                  onOpenChange(false)
                }}
                className="gap-1.5"
              >
                <Pencil className="size-3.5" />
                {t('common.edit', { defaultValue: 'Editar' })}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
