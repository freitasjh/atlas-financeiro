import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/ui/dialog'
import { Button } from '@/components/shadcn/ui/button'
import type { CreditCardInput } from '../model/credit-card'
import { CardFormFields, useCardForm, type CardAccountOption } from './CardFormFields'

interface AddCardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  accounts: CardAccountOption[]
  onSubmit: (input: CreditCardInput) => Promise<void>
}

export function AddCardDialog({ open, onOpenChange, accounts, onSubmit }: AddCardDialogProps) {
  const { t } = useTranslation()
  const form = useCardForm({ nickname: '', accountId: '', limitCents: null, closingDay: 10, dueDay: 20 })
  const [serverError, setServerError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const result = form.validate()
    if (!result) return
    setIsSubmitting(true)
    setServerError(null)
    try {
      await onSubmit(result.input)
      onOpenChange(false)
    } catch (error) {
      setServerError(error instanceof Error ? error.message : t('cards.installmentError'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain p-5 sm:max-w-2xl sm:p-6">
        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-foreground">{t('cards.new')}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {t('cards.createHint')}
            </DialogDescription>
          </DialogHeader>

          <CardFormFields form={form} accounts={accounts} />

          {serverError ? (
            <p role="alert" className="text-xs text-destructive">
              {serverError}
            </p>
          ) : null}

          <DialogFooter className="mt-5 flex flex-row items-center justify-end gap-3 sm:space-x-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="min-h-11">
              {t('cards.detail.close')}
            </Button>
            <Button type="submit" disabled={isSubmitting} className="min-h-11 font-semibold">
              {isSubmitting ? t('cards.transfer.submitting') : t('cards.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
