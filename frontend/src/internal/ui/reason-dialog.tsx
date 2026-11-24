/**
 * Confirmação de ação sensível (UX §4): consequência explícita + motivo.
 *
 * O motivo só aparece quando a RPC o aceita — campo que não é persistido seria
 * promessa falsa. A consequência é sempre obrigatória.
 */

import type { ReactNode } from "react"

import { Button } from "@/components/shadcn/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/shadcn/ui/dialog"
import { Label } from "@/components/shadcn/ui/label"
import { useInternalT } from "./use-internal-t"

export const REASON_MIN_LENGTH = 3

export interface InternalReasonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  consequence: string
  confirmLabel: string
  requireReason?: boolean
  reason?: string
  onReasonChange?: (value: string) => void
  reasonLabel?: string
  pending?: boolean
  error?: string | null
  children?: ReactNode
  onConfirm: () => void
}

export function InternalReasonDialog({
  open,
  onOpenChange,
  title,
  consequence,
  confirmLabel,
  requireReason = false,
  reason,
  onReasonChange,  reasonLabel,
  pending = false,
  error = null,
  children,
  onConfirm,
}: InternalReasonDialogProps) {
  const t = useInternalT()
  const reasonValue = reason ?? ""
  const reasonTooShort = requireReason && reasonValue.trim().length < REASON_MIN_LENGTH

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-h-[92vh] overflow-y-auto overscroll-contain p-5 sm:max-w-[480px] sm:p-6">
        <DialogHeader>
          <DialogTitle className="text-base font-bold text-foreground">{title}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {consequence}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          {children}
          {requireReason ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="internal-reason" className="text-xs font-medium">
                {reasonLabel ?? t("internalAdmin.actions.reasonLabel")}
              </Label>
              <textarea
                id="internal-reason"
                value={reasonValue}
                onChange={(event) => onReasonChange?.(event.target.value)}
                required
                aria-required="true"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              <p className="text-[11px] text-muted-foreground">
                {t("internalAdmin.actions.reasonHint")}
              </p>
            </div>
          ) : null}
          {error !== null ? (
            <p role="alert" className="text-xs font-medium text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="mt-5 flex flex-row items-center justify-end gap-3 sm:space-x-0">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>
            {t("internalAdmin.actions.cancel")}
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={pending || reasonTooShort}
            onClick={onConfirm}
          >
            {pending ? t("internalAdmin.actions.pending") : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
