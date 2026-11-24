import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
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

interface DeleteCardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cardName: string
  error: string | null
  isDeleting: boolean
  onConfirm: () => void
  onArchive: () => void
}

// Confirmação destrutiva: com histórico o banco recusa (card-has-history) e o
// diálogo oferece arquivar (oculta da lista, sem apagar histórico).
export function DeleteCardDialog({
  open,
  onOpenChange,
  cardName,
  error,
  isDeleting,
  onConfirm,
  onArchive,
}: DeleteCardDialogProps) {
  const { t } = useTranslation()
  const blocked = error !== null && error.includes('card-has-history')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain p-5 sm:max-w-md sm:p-6">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold text-foreground">
            {t('cards.deleteDialogTitle')}
          </DialogTitle>
          <DialogDescription className="min-w-0 text-xs text-muted-foreground">
            <span className="truncate">{t('cards.removeConfirm')}</span>
            <span className="mt-1 block truncate font-semibold text-foreground">{cardName}</span>
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{blocked ? t('cards.removeBlocked') : t('cards.removeError')}</AlertTitle>
            {blocked ? (
              <AlertDescription>{t('cards.archive.hint')}</AlertDescription>
            ) : null}
          </Alert>
        ) : null}

        <DialogFooter className="mt-5 flex flex-row items-center justify-end gap-3 sm:space-x-0">
          {blocked ? (
            <Button
              type="button"
              variant="outline"
              onClick={onArchive}
              disabled={isDeleting}
              className="min-h-11"
            >
              {t('cards.archive.action')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
            className="min-h-11"
          >
            {t('cards.detail.close')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={isDeleting}
            className="min-h-11 font-semibold"
          >
            {t('cards.remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
