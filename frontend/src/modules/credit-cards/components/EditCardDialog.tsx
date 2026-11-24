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
import type { CreditCardUpdateInput, CreditCardView } from '../model/credit-card'
import { CardFormFields, useCardForm, type CardAccountOption } from './CardFormFields'

interface EditCardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  card: CreditCardView | null
  accounts: CardAccountOption[]
  onSubmit: (id: string, patch: CreditCardUpdateInput) => Promise<void>
}

function EditCardFormBody({
  card,
  accounts,
  onSubmit,
  onClose,
}: {
  card: CreditCardView
  accounts: CardAccountOption[]
  onSubmit: (id: string, patch: CreditCardUpdateInput) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const form = useCardForm({
    nickname: card.nickname,
    accountId: card.accountId,
    limitCents: card.limitCents,
    closingDay: card.closingDay,
    dueDay: card.dueDay,
  })
  const [serverError, setServerError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const result = form.validate()
    if (!result) return
    setIsSubmitting(true)
    setServerError(null)
    try {
      const { brand: _brand, ...rest } = result.input
      void _brand
      await onSubmit(card.id, rest)
      onClose()
    } catch (error) {
      setServerError(error instanceof Error ? error.message : t('cards.installmentError'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="text-xl font-bold text-foreground">{t('cards.edit')}</DialogTitle>
        <DialogDescription className="text-xs text-muted-foreground">{t('cards.editHint')}</DialogDescription>
      </DialogHeader>

      <CardFormFields form={form} accounts={accounts} />

      {serverError ? (
        <p role="alert" className="text-xs text-destructive">
          {serverError}
        </p>
      ) : null}

      <DialogFooter className="mt-5 flex flex-row items-center justify-end gap-3 sm:space-x-0">
        <Button type="button" variant="outline" onClick={onClose} className="min-h-11">
          {t('cards.detail.close')}
        </Button>
        <Button type="submit" disabled={isSubmitting} className="min-h-11 font-semibold">
          {isSubmitting ? t('cards.transfer.submitting') : t('cards.update')}
        </Button>
      </DialogFooter>
    </form>
  )
}

// Pré-preenchido: `key={card.id}` reseta o formulário ao trocar de cartão.
export function EditCardDialog({ open, onOpenChange, card, accounts, onSubmit }: EditCardDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain p-5 sm:max-w-xl sm:p-6">
        {card ? (
          <EditCardFormBody
            key={card.id}
            card={card}
            accounts={accounts}
            onSubmit={onSubmit}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
