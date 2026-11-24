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

// C2.4 — exclusão permitida: confirm destrutivo citando o nome.

interface CategoryDeleteDialogProps {
  open: boolean
  categoryName: string
  isDeleting: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function CategoryDeleteDialog({
  open,
  categoryName,
  isDeleting,
  error,
  onOpenChange,
  onConfirm,
}: CategoryDeleteDialogProps) {
  const { t } = useTranslation()
  const name = categoryName.trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('categories.deleteTitle')}</DialogTitle>
          <DialogDescription>{t('categories.deleteHint', { name })}</DialogDescription>
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
            {t('categories.deleteCancel')}
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
            {t('categories.deleteConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
