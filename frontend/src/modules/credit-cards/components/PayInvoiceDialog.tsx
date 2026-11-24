import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/ui/alert'
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shadcn/ui/select'
import { formatCentsBRL } from '@/lib/utils'
import type { InvoiceRow } from '../service/credit-cards.service'

export interface PayAccountOption {
  id: string
  name: string
  balanceCents: number | null
}

interface PayInvoiceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice: InvoiceRow | null
  // Devedor calculado no banco (selectedRemainingCents): exibição apenas; a RPC
  // recalcula o valor no servidor — o cliente nunca monta o valor.
  remainingCents: number
  accounts: PayAccountOption[]
  defaultAccountId?: string
  serverError?: string | null
  isPaying?: boolean
  onConfirm: (accountId: string, date: string) => Promise<void>
}

function todayLocalISO(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function serverErrorKey(message: string | null | undefined): string | null {
  if (!message) return null
  if (message.includes('invoice-nothing-to-pay')) return 'cards.transfer.nothingToPay'
  if (message.includes('invoice-already-paid')) return 'cards.transfer.alreadyPaid'
  if (message.includes('invoice-tenant-mismatch')) return 'cards.transfer.tenantMismatch'
  if (message.includes('invoice-paid-locked')) return 'cards.transfer.paidLocked'
  if (message.includes('account-not-found')) return 'cards.transfer.accountNotFound'
  if (message.includes('invoice-not-found')) return 'cards.transfer.invoiceNotFound'
  return 'cards.transfer.error'
}

// Pagamento via RPC pay_invoice: conta débito (Select w-full) + data; valor em
// destaque tabular-nums apenas para conferência.
export function PayInvoiceDialog({
  open,
  onOpenChange,
  invoice,
  remainingCents,
  accounts,
  defaultAccountId,
  serverError,
  isPaying = false,
  onConfirm,
}: PayInvoiceDialogProps) {
  const { t, i18n } = useTranslation()
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id ?? '')
  const [date, setDate] = useState(todayLocalISO())
  const [dateError, setDateError] = useState<string | null>(null)
  const dateRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setAccountId(defaultAccountId ?? accounts[0]?.id ?? '')
    setDate(todayLocalISO())
    setDateError(null)
  }, [open, defaultAccountId, accounts])

  if (!invoice) return null

  const errorKey = serverErrorKey(serverError)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setDateError(t('cards.payDateError'))
      dateRef.current?.focus()
      return
    }
    setDateError(null)
    await onConfirm(accountId, date)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain p-5 sm:max-w-md sm:p-6">
        <form onSubmit={(event) => void handleSubmit(event)} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-foreground">
              {t('cards.transfer.title')}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {t('cards.transfer.internalHint')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-muted/20 p-4">
            <span className="text-xs font-medium text-muted-foreground">
              {t('cards.payRemaining')}
            </span>
            <span className="font-mono text-2xl font-bold tabular-nums tracking-tight text-foreground">
              {formatCentsBRL(remainingCents, i18n.language)}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-account" className="text-xs font-medium">
              {t('cards.transfer.source')} *
            </Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="pay-account" className="h-10 w-full">
                <SelectValue placeholder={t('cards.selectAccount')} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      <span className="flex items-center gap-2">
                        <span>{account.name}</span>
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {account.balanceCents === null
                            ? t('cards.transfer.balanceUnavailable')
                            : formatCentsBRL(account.balanceCents, i18n.language)}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-date" className="text-xs font-medium">
              {t('cards.payDate')} *
            </Label>
            <Input
              id="pay-date"
              name="date"
              ref={dateRef}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              aria-invalid={dateError ? true : undefined}
              className="h-10 w-full font-mono tabular-nums"
            />
            {dateError ? (
              <p role="alert" className="text-xs text-destructive">
                {dateError}
              </p>
            ) : null}
          </div>

          {errorKey ? (
            <Alert variant="destructive">
              <AlertTitle>{t('cards.transfer.error')}</AlertTitle>
              <AlertDescription>{t(errorKey)}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter className="mt-5 flex flex-row items-center justify-end gap-3 sm:space-x-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPaying}
              className="min-h-11"
            >
              {t('cards.detail.close')}
            </Button>
            <Button type="submit" disabled={isPaying || accountId === ''} className="min-h-11 font-semibold">
              {isPaying ? t('cards.transfer.submitting') : t('cards.transfer.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
