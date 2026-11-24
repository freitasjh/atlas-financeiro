import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/shadcn/ui/alert'
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shadcn/ui/select'
import { maskCentsInput, parseBRLToCents } from '@/lib/money'
import { formatCentsBRL } from '@/lib/utils'
import {
  todayLocalISO,
  type CreditCardView,
} from '../model/credit-card'
import { routeInvoice, type InvoiceCycle } from '../model/invoice-routing'
import { addMonthsISO, MAX_INSTALLMENTS, splitInstallments } from '../model/installments'

// 1 = compra à vista (createCardPurchase); 2..24 = createInstallmentPurchase.
// MIN_INSTALLMENTS do model é 2 (split de parcelas) e NÃO se aplica ao formulário.
const MIN_PURCHASE_INSTALLMENTS = 1
import {
  CategoryTenantMismatchError,
  InvoiceAlreadyPaidError,
  InvoiceCardMismatchError,
  PurchaseInvoicePaidError,
} from '../service/credit-cards.service'

export interface PurchaseCategoryOption {
  id: string
  name: string
}

export interface CardPurchaseSubmitInput {
  description: string
  totalCents: number
  date: string
  categoryId: string | null
  installments: number
}

interface CardPurchaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  card: CreditCardView | null
  categories: PurchaseCategoryOption[]
  onSubmit: (input: CardPurchaseSubmitInput) => Promise<void>
}

const NO_CATEGORY = '__none__'

interface FieldErrors {
  description?: string
  amount?: string
  date?: string
  count?: string
}

export interface PurchasePreview {
  schedule: number[]
  cycles: InvoiceCycle[]
  totalCents: number
}

// Prévia 100% pura: reusa RN02/RN03 do model, sem duplicar regra de negócio.
export function buildPurchasePreview(
  card: CreditCardView,
  totalCents: number,
  date: string,
  count: number,
): PurchasePreview {
  const schedule = count === 1 ? [totalCents] : splitInstallments(totalCents, count)
  const cycles: InvoiceCycle[] = []
  for (let index = 0; index < count; index += 1) {
    const cycle = routeInvoice(addMonthsISO(date, index), card.closingDay, card.dueDay)
    if (!cycles.some((item) => item.period_start === cycle.period_start)) cycles.push(cycle)
  }
  return { schedule, cycles, totalCents }
}

// 🟡1 — PurchaseInvoicePaidError e InvoiceAlreadyPaidError compartilham a
// message 'invoice-already-paid'. NUNCA mapear por message: identidade primeiro,
// name como fallback (ex.: erro vindo de boundary de serialização).
export function purchaseErrorKey(error: unknown): string {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : ''
  if (error instanceof PurchaseInvoicePaidError || name === 'PurchaseInvoicePaidError') {
    return 'cards.purchase.errorPaidCycle'
  }
  if (error instanceof InvoiceAlreadyPaidError || name === 'InvoiceAlreadyPaidError') {
    return 'cards.purchase.errorAlreadyPaid'
  }
  if (error instanceof CategoryTenantMismatchError || name === 'CategoryTenantMismatchError') {
    return 'cards.purchase.errorCategory'
  }
  if (error instanceof InvoiceCardMismatchError || name === 'InvoiceCardMismatchError') {
    return 'cards.purchase.errorCardMismatch'
  }
  return 'cards.installmentError'
}

export function CardPurchaseDialog({
  open,
  onOpenChange,
  card,
  categories,
  onSubmit,
}: CardPurchaseDialogProps) {
  const { t, i18n } = useTranslation()
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayLocalISO())
  const [count, setCount] = useState('1')
  const [categoryKey, setCategoryKey] = useState(NO_CATEGORY)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [serverErrorKey, setServerErrorKey] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const descriptionRef = useRef<HTMLInputElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const dateRef = useRef<HTMLInputElement>(null)
  const countRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setDescription('')
    setAmount('')
    setDate(todayLocalISO())
    setCount('1')
    setCategoryKey(NO_CATEGORY)
    setErrors({})
    setServerErrorKey(null)
    setIsSubmitting(false)
  }, [open])

  const parsedCents = parseBRLToCents(amount)
  const parsedCount = Number(count)
  const preview = useMemo(
    () =>
      card && parsedCents !== null && parsedCents > 0 && Number.isInteger(parsedCount) && parsedCount >= MIN_PURCHASE_INSTALLMENTS && parsedCount <= MAX_INSTALLMENTS
        ? buildPurchasePreview(card, parsedCents, date, parsedCount)
        : null,
    [card, parsedCents, date, parsedCount],
  )

  if (!card) return null

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = description.trim()
    const cents = parseBRLToCents(amount)
    const next: FieldErrors = {}
    if (trimmed === '') next.description = t('cards.installmentDescriptionError')
    if (cents === null || !Number.isInteger(cents) || cents <= 0) {
      next.amount = t('cards.installmentTotalError')
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) next.date = t('cards.installmentDateError')
    const installments = Number(count)
    if (
      !Number.isInteger(installments) ||
      installments < MIN_PURCHASE_INSTALLMENTS ||
      installments > MAX_INSTALLMENTS
    ) {
      next.count = t('cards.installmentCountError')
    }
    setErrors(next)
    setServerErrorKey(null)

    const firstInvalid = next.description
      ? descriptionRef.current
      : next.amount
        ? amountRef.current
        : next.date
          ? dateRef.current
          : next.count
            ? countRef.current
            : null
    if (firstInvalid) {
      firstInvalid.focus()
      return
    }
    if (cents === null) return

    setIsSubmitting(true)
    try {
      await onSubmit({
        description: trimmed,
        totalCents: cents,
        date,
        categoryId: categoryKey === NO_CATEGORY ? null : categoryKey,
        installments,
      })
      onOpenChange(false)
    } catch (error) {
      setServerErrorKey(purchaseErrorKey(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain p-5 sm:max-w-2xl sm:p-6">
        <form onSubmit={(event) => void handleSubmit(event)} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-foreground">
              {t('cards.purchase.title')}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {t('cards.purchase.countHint')}
            </DialogDescription>
          </DialogHeader>

          <div className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="purchase-description" className="text-xs font-medium">
                {t('cards.installmentDescription')}
              </Label>
              <Input
                id="purchase-description"
                name="description"
                ref={descriptionRef}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('cards.installmentDescriptionPlaceholder')}
                aria-invalid={errors.description ? true : undefined}
                className="h-10 w-full sm:h-11"
              />
              {errors.description ? (
                <p role="alert" className="text-xs text-destructive">
                  {errors.description}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="purchase-category" className="text-xs font-medium">
                {t('cards.purchase.category')}
              </Label>
              <Select value={categoryKey} onValueChange={setCategoryKey}>
                <SelectTrigger
                  id="purchase-category"
                  aria-label={t('cards.purchase.category')}
                  className="h-10 w-full sm:h-11"
                >
                  <SelectValue placeholder={t('cards.purchase.categoryPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY}>{t('cards.purchase.categoryPlaceholder')}</SelectItem>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="purchase-amount" className="text-xs font-medium">
                {t('cards.installmentTotal')}
              </Label>
              <Input
                id="purchase-amount"
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                ref={amountRef}
                value={amount}
                onChange={(event) => setAmount(maskCentsInput(event.target.value))}
                placeholder="0,00"
                aria-invalid={errors.amount ? true : undefined}
                className="h-10 w-full font-mono tabular-nums sm:h-11"
              />
              {errors.amount ? (
                <p role="alert" className="text-xs text-destructive">
                  {errors.amount}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="purchase-date" className="text-xs font-medium">
                {t('cards.purchaseDate')}
              </Label>
              <Input
                id="purchase-date"
                name="date"
                type="date"
                ref={dateRef}
                value={date}
                onChange={(event) => setDate(event.target.value)}
                aria-invalid={errors.date ? true : undefined}
                className="h-10 w-full font-mono tabular-nums sm:h-11"
              />
              {errors.date ? (
                <p role="alert" className="text-xs text-destructive">
                  {errors.date}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="purchase-count" className="text-xs font-medium">
                {t('cards.installmentCount')}
              </Label>
              <Input
                id="purchase-count"
                name="count"
                type="number"
                min={MIN_PURCHASE_INSTALLMENTS}
                max={MAX_INSTALLMENTS}
                ref={countRef}
                value={count}
                onChange={(event) => {
                  const raw = Number(event.target.value)
                  const valid =
                    Number.isInteger(raw) &&
                    raw >= MIN_PURCHASE_INSTALLMENTS &&
                    raw <= MAX_INSTALLMENTS
                      ? raw
                      : MIN_PURCHASE_INSTALLMENTS
                  setCount(String(valid))
                }}
                aria-invalid={errors.count ? true : undefined}
                className="h-10 w-full font-mono tabular-nums sm:h-11"
              />
              {errors.count ? (
                <p role="alert" className="text-xs text-destructive">
                  {errors.count}
                </p>
              ) : null}
            </div>
          </div>

          {preview ? (
            <div
              data-testid="cards-purchase-preview"
              className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border/70 bg-muted/20 p-4"
            >
              <span className="text-xs font-medium text-muted-foreground">
                {t('cards.installmentPreview')}
              </span>
              <ul className="flex min-w-0 flex-col gap-1">
                {preview.schedule.map((cents, index) => (
                  <li key={index} className="flex min-w-0 items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">
                      {t('cards.installmentLabel', { n: index + 1 })}/{preview.schedule.length}
                    </span>
                    <span className="font-mono font-semibold tabular-nums text-foreground">
                      {formatCentsBRL(cents, i18n.language)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="flex min-w-0 items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">{t('cards.installmentSum')}</span>
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {formatCentsBRL(preview.totalCents, i18n.language)}
                </span>
              </p>
              <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>{t('cards.purchase.previewInvoice')}:</span>
                <span className="font-mono tabular-nums text-foreground">
                  {preview.cycles[0]?.period_start} — {preview.cycles[0]?.period_end}
                </span>
                {preview.cycles.length > 1 ? (
                  <span className="font-mono tabular-nums">
                    {t('cards.purchase.cycleCount', { count: preview.cycles.length })}
                  </span>
                ) : null}
              </p>
            </div>
          ) : null}

          {serverErrorKey ? (
            <Alert variant="destructive">
              <AlertDescription>{t(serverErrorKey)}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter className="mt-5 flex flex-row items-center justify-end gap-3 sm:space-x-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
              className="min-h-11"
            >
              {t('cards.purchase.close')}
            </Button>
            <Button type="submit" disabled={isSubmitting} className="min-h-11 font-semibold">
              {isSubmitting ? t('cards.transfer.submitting') : t('cards.installmentSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
