import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/shadcn/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/ui/dialog'
import { Input } from '@/components/shadcn/ui/input'
import { Label } from '@/components/shadcn/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shadcn/ui/select'
import { Alert, AlertDescription } from '@/components/shadcn/ui/alert'
import { formatCentsBRL } from '@/lib/utils'
import { maskCentsInput, parseBRLToCents } from '@/lib/money'
import { MONTH_RE, toMonthFirstDay, type BudgetInput } from '../model/budget'

// O2.2 — BudgetDialog: Categoria (Select) + Mês (type=month) + Teto (R$
// com máscara de centavos). Validação inline + foco no 1º inválido;
// sm:max-w-[480px]; dinheiro sempre em cents (sem float).

export interface BudgetDialogInitial {
  categoryId: string
  month: string
  limitCents: number
}

export interface BudgetCategoryOption {
  id: string
  name: string
}

interface BudgetDialogProps {
  open: boolean
  mode: 'create' | 'edit'
  initial?: BudgetDialogInitial
  categories: BudgetCategoryOption[]
  isSaving: boolean
  serverError: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (values: BudgetInput) => Promise<void>
}

export function BudgetDialog({
  open,
  mode,
  initial,
  categories,
  isSaving,
  serverError,
  onOpenChange,
  onSubmit,
}: BudgetDialogProps) {
  const { t } = useTranslation()
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? '')
  const [monthValue, setMonthValue] = useState(() =>
    (initial?.month ?? toMonthFirstDay(new Date())).slice(0, 7),
  )
  const [amountText, setAmountText] = useState(() =>
    initial ? formatCentsBRL(initial.limitCents).replace(/^R\$\s?/, '') : '',
  )
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [monthError, setMonthError] = useState<string | null>(null)
  const [limitError, setLimitError] = useState<string | null>(null)

  const categoryTriggerRef = useRef<HTMLButtonElement>(null)
  const monthRef = useRef<HTMLInputElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)

  // Re-sincroniza ao abrir (mesmo dialog serve criar + editar).
  useEffect(() => {
    if (open) {
      setCategoryId(initial?.categoryId ?? '')
      setMonthValue((initial?.month ?? toMonthFirstDay(new Date())).slice(0, 7))
      setAmountText(initial ? formatCentsBRL(initial.limitCents).replace(/^R\$\s?/, '') : '')
      setCategoryError(null)
      setMonthError(null)
      setLimitError(null)
      requestAnimationFrame(() => categoryTriggerRef.current?.focus())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Validação em ordem + foco no 1º inválido.
    if (!categoryId) {
      setCategoryError(t('budgets.categoryError'))
      categoryTriggerRef.current?.focus()
      return
    }
    setCategoryError(null)
    const month = `${monthValue}-01`
    if (!MONTH_RE.test(month)) {
      setMonthError(t('budgets.monthError'))
      monthRef.current?.focus()
      return
    }
    setMonthError(null)
    const limitCents = parseBRLToCents(amountText)
    // positive(): teto zero não é teto — copy alinhada com a validação.
    if (limitCents === null || limitCents <= 0) {
      setLimitError(t('budgets.limitError'))
      amountRef.current?.focus()
      return
    }
    setLimitError(null)
    await onSubmit({ category_id: categoryId, month, limit_cents: limitCents })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('budgets.create') : t('budgets.edit')}</DialogTitle>
          <DialogDescription>
            {mode === 'create' ? t('budgets.createHint') : t('budgets.editHint')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="budget-category" className="text-xs font-medium">
              {t('budgets.category')} *
            </Label>
            <Select
              value={categoryId}
              onValueChange={(v) => setCategoryId(v)}
              disabled={mode === 'edit'}
            >
              <SelectTrigger
                id="budget-category"
                ref={categoryTriggerRef}
                aria-label={`${t('budgets.category')} *`}
                aria-invalid={categoryError ? true : undefined}
                aria-describedby={
                  categoryError
                    ? 'budget-category-error'
                    : mode === 'edit'
                      ? 'budget-category-locked'
                      : undefined
                }
                className="h-10 w-full"
              >
                <SelectValue placeholder={t('budgets.selectCategory')} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {mode === 'edit' ? (
              <p id="budget-category-locked" className="text-xs text-muted-foreground">
                {t('budgets.categoryLocked')}
              </p>
            ) : null}
            {categoryError ? (
              <p id="budget-category-error" role="alert" className="text-xs text-destructive">
                {categoryError}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="budget-month" className="text-xs font-medium">
              {t('budgets.month')} *
            </Label>
            <Input
              ref={monthRef}
              id="budget-month"
              name="month"
              type="month"
              value={monthValue}
              onChange={(e) => setMonthValue(e.target.value)}
              aria-invalid={monthError ? true : undefined}
              aria-describedby={monthError ? 'budget-month-error' : undefined}
              className="h-10 w-full"
              required
            />
            {monthError ? (
              <p id="budget-month-error" role="alert" className="text-xs text-destructive">
                {monthError}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="budget-limit" className="text-xs font-medium">
              {t('budgets.limit')} *
            </Label>
            <div className="relative w-full">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-muted-foreground">
                R$
              </span>
              <Input
                ref={amountRef}
                id="budget-limit"
                name="limit"
                type="text"
                inputMode="decimal"
                placeholder={t('budgets.limitPlaceholder')}
                value={amountText}
                onChange={(e) => setAmountText(maskCentsInput(e.target.value))}
                aria-invalid={limitError ? true : undefined}
                aria-describedby={limitError ? 'budget-limit-error' : undefined}
                className="h-10 w-full pl-10 text-base font-bold"
                required
              />
            </div>
            {limitError ? (
              <p id="budget-limit-error" role="alert" className="text-xs text-destructive">
                {limitError}
              </p>
            ) : null}
          </div>

          {serverError ? (
            <Alert variant="destructive">
              <AlertDescription role="alert">{serverError}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter className="mt-1 flex flex-row items-center justify-end gap-3 sm:space-x-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="min-h-11"
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={isSaving} aria-busy={isSaving} className="min-h-11 font-semibold">
              {isSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {mode === 'create' ? t('budgets.create') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
