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
import { Alert, AlertDescription } from '@/components/shadcn/ui/alert'

// O2.2 — exclusão de teto: confirm destrutivo citando o nome da categoria.

interface BudgetDeleteDialogProps {
  open: boolean
  categoryName: string
  isDeleting: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function BudgetDeleteDialog({
  open,
  categoryName,
  isDeleting,
  error,
  onOpenChange,
  onConfirm,
}: BudgetDeleteDialogProps) {
  const { t } = useTranslation()
  const name = categoryName.trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('budgets.removeTitle')}</DialogTitle>
          <DialogDescription>{t('budgets.removeHint', { name })}</DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription role="alert">{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter className="mt-2 flex flex-row items-center justify-end gap-3 sm:space-x-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="min-h-11"
          >
            {t('budgets.deleteCancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={isDeleting}
            aria-busy={isDeleting}
            className="min-h-11"
          >
            {isDeleting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {t('budgets.deleteConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
