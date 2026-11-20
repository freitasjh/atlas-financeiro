import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowDownRight, ArrowUpRight, CheckCircle2, Loader2, Search } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/ui/dialog'
import { Button } from '@/components/shadcn/ui/button'
import { Input } from '@/components/shadcn/ui/input'
import { Label } from '@/components/shadcn/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shadcn/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/ui/alert'
import { Checkbox } from '@/components/shadcn/ui/checkbox'
import { cn } from '@/lib/cn'
import { parseBRLToCents, maskCentsInput } from '@/lib/money'
import { formatCentsBRL } from '@/lib/utils'
import type { TransactionView } from '../model/view-model'

export interface TransactionDialogSaveData {
  id?: string
  description: string
  amountCents: number
  amount_cents: number
  type: 'income' | 'expense'
  date: string
  accountId: string
  account_id: string
  categoryId: string | null
  category_id: string | null
  reconciled: boolean
}

interface TransactionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave?: (data: TransactionDialogSaveData) => void | Promise<void>
  onSubmit?: (data: TransactionDialogSaveData) => void | Promise<void>
  transactionToEdit?: TransactionView | null
  transaction?: TransactionView | null
  accounts?: Array<string | { id?: string; name: string }>
  categories?: Array<string | CategoryOption>
}

export interface CategoryOption {
  id: string
  name: string
  type?: string
}

function centsToInput(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return ''
  return formatCentsBRL(cents).replace(/^R\$\s?/, '')
}

function normalizeAccounts(accounts?: Array<string | { id?: string; name: string }>) {
  if (!accounts || accounts.length === 0) return []
  return accounts.map((a) =>
    typeof a === 'string' ? { id: a, name: a } : { id: a.id ?? a.name, name: a.name },
  )
}

function normalizeCategories(categories?: Array<string | CategoryOption>): CategoryOption[] {
  if (!categories || categories.length === 0) return []
  return categories.map((c) =>
    typeof c === 'string' ? { id: c, name: c } : c,
  )
}

export function TransactionDialog({
  open,
  onOpenChange,
  onSave,
  onSubmit,
  transactionToEdit,
  transaction,
  accounts,
  categories,
}: TransactionDialogProps) {
  const { t } = useTranslation()
  const editing = transactionToEdit ?? transaction ?? null

  const accountOptions = useMemo(() => normalizeAccounts(accounts), [accounts])
  const categoryOptions = useMemo(() => normalizeCategories(categories), [categories])

  const [type, setType] = useState<'income' | 'expense'>('income')
  const [description, setDescription] = useState('')
  const [amountStr, setAmountStr] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [accountId, setAccountId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [categorySearch, setCategorySearch] = useState('')
  const [reconciled, setReconciled] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [errorTarget, setErrorTarget] = useState<'description' | 'amount' | 'account' | 'date' | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const descriptionRef = useRef<HTMLInputElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const accountRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    setFormError(null)
    setErrorTarget(null)
    setIsSubmitting(false)
    setCategorySearch('')
    if (editing) {
      setType(editing.type === 'income' ? 'income' : 'expense')
      setDescription(editing.description ?? '')
      setAmountStr(centsToInput(editing.amountCents))
      setDate(editing.date ?? new Date().toISOString().slice(0, 10))
      setAccountId(editing.accountId ?? '')
      setCategoryId(editing.categoryId ?? '')
      setReconciled(Boolean(editing.reconciled ?? editing.status === 'reconciled'))
    } else {
      setType('income')
      setDescription('')
      setAmountStr('')
      setDate(new Date().toISOString().slice(0, 10))
      setAccountId(accountOptions[0]?.id ?? '')
      setCategoryId('')
      setReconciled(false)
    }
  }, [open, editing, accountOptions])

  const visibleCategories = useMemo(() => {
    const query = categorySearch.trim().toLowerCase()
    return categoryOptions.filter((c) => {
      if (c.type && c.type !== type) return false
      if (!query) return true
      return c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query)
    })
  }, [categoryOptions, categorySearch, type])

  function handleTypeChange(next: 'income' | 'expense') {
    setType(next)
    setCategoryId((current) => {
      if (!current) return current
      const selected = categoryOptions.find((c) => c.id === current)
      if (selected?.type && selected.type !== next) return ''
      return current
    })
  }

  function fail(message: string, target: typeof errorTarget, ref?: { current: HTMLElement | null } | null) {
    setFormError(message)
    setErrorTarget(target)
    toast.error(message)
    ref?.current?.focus()
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setFormError(null)
    setErrorTarget(null)

    if (!description.trim()) {
      fail(t('transactions.descriptionError', { defaultValue: 'Informe uma descrição para a transação.' }), 'description', descriptionRef)
      return
    }
    const cents = parseBRLToCents(amountStr)
    if (cents === null || cents <= 0) {
      fail(t('transactions.amountError', { defaultValue: 'Informe um valor válido maior que zero com até 2 casas decimais.' }), 'amount', amountRef)
      return
    }
    if (!date) {
      fail(t('transactions.dateError', { defaultValue: 'Informe a data da transação.' }), 'date', null)
      return
    }
    if (!accountId) {
      fail(t('transactions.missingAccount', { defaultValue: 'Selecione uma conta.' }), 'account', accountRef)
      return
    }

    const payload: TransactionDialogSaveData = {
      ...(editing?.id ? { id: editing.id } : {}),
      description: description.trim(),
      amountCents: cents,
      amount_cents: cents,
      type,
      date,
      accountId,
      account_id: accountId,
      categoryId: categoryId || null,
      category_id: categoryId || null,
      reconciled,
    }

    setIsSubmitting(true)
    try {
      const saver = onSave ?? onSubmit
      await saver?.(payload)
      setFormError(null)
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.error', { defaultValue: 'Algo deu errado. Tente novamente.' })
      setFormError(message)
      toast.error(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const isEditing = Boolean(editing)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain p-5 sm:max-w-[520px] sm:p-6">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="text-base font-bold">
            {isEditing
              ? t('transactions.editTitle', { defaultValue: 'Editar transação' })
              : t('transactions.newTitle', { defaultValue: 'Nova transação' })}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isEditing
              ? t('transactions.editHint', { defaultValue: 'Atualize os dados do lançamento.' })
              : t('transactions.newHint', { defaultValue: 'Preencha os dados do lançamento.' })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4 pt-1" noValidate>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 block text-xs font-semibold text-foreground">
              {t('transactions.type', { defaultValue: 'Tipo' })}
            </legend>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => handleTypeChange('income')}
                aria-pressed={type === 'income'}
                className={cn(
                  'min-h-11 rounded-lg border px-2.5 py-2 text-center text-xs transition-all',
                  type === 'income'
                    ? 'border-emerald-500/60 bg-emerald-500/10 font-bold text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-500/30'
                    : 'border-border/80 bg-card text-muted-foreground hover:text-foreground',
                )}
              >
                <ArrowUpRight className="mr-1 inline size-3.5" aria-hidden="true" />
                {t('transactions.income', { defaultValue: 'Receita' })}
              </button>
              <button
                type="button"
                onClick={() => handleTypeChange('expense')}
                aria-pressed={type === 'expense'}
                className={cn(
                  'min-h-11 rounded-lg border px-2.5 py-2 text-center text-xs transition-all',
                  type === 'expense'
                    ? 'border-rose-500/60 bg-rose-500/10 font-bold text-rose-700 dark:text-rose-400 ring-1 ring-rose-500/30'
                    : 'border-border/80 bg-card text-muted-foreground hover:text-foreground',
                )}
              >
                <ArrowDownRight className="mr-1 inline size-3.5" aria-hidden="true" />
                {t('transactions.expense', { defaultValue: 'Despesa' })}
              </button>
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tx-description" className="text-xs font-semibold text-foreground">
              {t('transactions.description', { defaultValue: 'Descrição' })} *
            </Label>
            <Input
              id="tx-description"
              ref={descriptionRef}
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-invalid={errorTarget === 'description'}
              aria-describedby={formError && errorTarget === 'description' ? 'tx-error' : undefined}
              className="min-h-11 w-full"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tx-amount" className="text-xs font-semibold text-foreground">
                {t('transactions.amount', { defaultValue: 'Valor (R$)' })} *
              </Label>
              <Input
                id="tx-amount"
                ref={amountRef}
                type="text"
                inputMode="decimal"
                value={amountStr}
                onChange={(e) => setAmountStr(maskCentsInput(e.target.value))}
                aria-invalid={errorTarget === 'amount'}
                className="min-h-11 w-full tabular-nums"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tx-date" className="text-xs font-semibold text-foreground">
                {t('transactions.date', { defaultValue: 'Data' })} *
              </Label>
              <Input
                id="tx-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-invalid={errorTarget === 'date'}
                className="min-h-11 w-full"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tx-account" className="text-xs font-semibold text-foreground">
              {t('transactions.account', { defaultValue: 'Conta' })} *
            </Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="tx-account" ref={accountRef as unknown as React.Ref<HTMLButtonElement>} className="min-h-11 w-full" aria-invalid={errorTarget === 'account'}>
                <SelectValue placeholder={t('transactions.selectAccount', { defaultValue: 'Selecione a conta' })} />
              </SelectTrigger>
              <SelectContent>
                {accountOptions.map((acc) => (
                  <SelectItem key={acc.id} value={acc.id}>
                    {acc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tx-category" className="text-xs font-semibold text-foreground">
              {t('transactions.category', { defaultValue: 'Categoria' })}
            </Label>
            <Select
              value={categoryId || 'none'}
              onValueChange={(v) => {
                setCategoryId(v === 'none' ? '' : v)
                setCategorySearch('')
              }}
            >
              <SelectTrigger id="tx-category" className="min-h-11 w-full">
                <SelectValue placeholder={t('transactions.selectCategory', { defaultValue: 'Sem categoria' })} />
              </SelectTrigger>
              <SelectContent>
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-popover px-2 py-1.5">
                  <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <input
                    type="search"
                    aria-label={t('transactions.searchCategory', { defaultValue: 'Buscar categoria' })}
                    placeholder={t('transactions.searchCategory', { defaultValue: 'Buscar categoria' })}
                    value={categorySearch}
                    onChange={(e) => setCategorySearch(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="h-8 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <SelectItem value="none">{t('transactions.noCategory', { defaultValue: 'Sem categoria' })}</SelectItem>
                {visibleCategories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name}
                  </SelectItem>
                ))}
                {visibleCategories.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    {t('transactions.noCategoryResults', { defaultValue: 'Nenhuma categoria encontrada.' })}
                  </div>
                ) : null}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="tx-reconciled"
              checked={reconciled}
              onCheckedChange={(v) => setReconciled(v === true)}
            />
            <Label htmlFor="tx-reconciled" className="text-xs font-medium text-foreground">
              {t('transactions.reconciled', { defaultValue: 'Conciliado' })}
            </Label>
          </div>

          {formError ? (
            <Alert variant="destructive" id="tx-error" role="alert">
              <AlertTitle>{t('common.error', { defaultValue: 'Erro' })}</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter className="flex items-center justify-end gap-3 border-t border-border/60 pt-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="min-h-11">
              {t('common.cancel', { defaultValue: 'Cancelar' })}
            </Button>
            <Button type="submit" disabled={isSubmitting} aria-busy={isSubmitting} className="min-h-11 font-bold">
              {isSubmitting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="size-4" aria-hidden="true" />}
              {isEditing
                ? t('common.save', { defaultValue: 'Salvar' })
                : t('common.create', { defaultValue: 'Cadastrar' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
