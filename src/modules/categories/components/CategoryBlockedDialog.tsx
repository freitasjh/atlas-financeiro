import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/shadcn/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/ui/dialog'

// C2.4 — exclusão bloqueada: dialog informativo âmbar PERSISTENTE
// (contagem tabular-nums, motivo honesto, Entendido + Ver lançamentos).
// NUNCA toast-only: o bloqueio exige leitura, não some em 3s.

interface CategoryBlockedDialogProps {
  open: boolean
  categoryId: string
  categoryName: string
  usageCount: number
  isSystem: boolean
  onOpenChange: (open: boolean) => void
}

export function CategoryBlockedDialog({
  open,
  categoryId,
  categoryName,
  usageCount,
  isSystem,
  onOpenChange,
}: CategoryBlockedDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-4" aria-hidden="true" />
            </span>
            {t('categories.blockedTitle')}
          </DialogTitle>
          <DialogDescription>
            {isSystem
              ? t('categories.blockedSystem')
              : t('categories.blockedInUse', { count: usageCount })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 w-full items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">{categoryName}</p>
            {!isSystem ? (
              <p className="font-mono text-xs tabular-nums text-amber-600 dark:text-amber-400">
                {t('categories.blockedCount', { count: usageCount })}
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter className="mt-2 flex flex-row items-center justify-end gap-3 sm:space-x-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="min-h-11"
          >
            {t('categories.blockedUnderstand')}
          </Button>
          {!isSystem ? (
            <Button type="button" asChild className="min-h-11">
              <Link to={`/lancamentos?categoria=${encodeURIComponent(categoryId)}`}>
                {t('categories.blockedViewEntries')}
              </Link>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
