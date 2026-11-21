/**
 * Códigos de recuperação MFA — etapa 3 do enrollment e gestão (ADR-001 UI-01/UI-03).
 *
 * Lista em texto claro aparece **uma única vez**; nenhuma reconsulta, nenhum
 * log. Componente apresentacional: toda I/O entra por props injetadas.
 */

import { useEffect, useState } from "react"
import { Copy, Download, KeyRound, RefreshCw, ShieldAlert } from "lucide-react"

import { Button } from "@/components/shadcn/ui/button"
import { Checkbox } from "@/components/shadcn/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/shadcn/ui/dialog"
import { Input } from "@/components/shadcn/ui/input"
import { Label } from "@/components/shadcn/ui/label"
import {
  formatRecoveryCode,
  recoveryCodesToTxt,
  RECOVERY_CONFIRMATION,
  type RecoveryStatus,
} from "@/internal/data/mfa-recovery-codes"
import { useInternalT } from "./use-internal-t"

export interface MfaRecoveryCodesDialogProps {
  open: boolean
  mode: "enroll" | "manage"
  codes?: readonly string[]
  status?: RecoveryStatus | null
  newCodes?: readonly string[] | null
  loading?: boolean
  error?: string | null
  onConfirm?: () => void | Promise<void>
  onRegenerate?: (confirmation: string) => Promise<void>
  onDone?: () => void
  onOpenChange?: (open: boolean) => void
}

type View = "status" | "confirm"

function CodesList({ codes }: { codes: readonly string[] }) {
  return (
    <ol className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {codes.map((code, index) => (
        <li
          key={`${index}-${formatRecoveryCode(code)}`}
          className="flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2"
        >
          <span className="w-5 shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {String(index + 1).padStart(2, "0")}
          </span>
          <code className="min-w-0 truncate font-mono text-xs tabular-nums text-foreground">
            {formatRecoveryCode(code)}
          </code>
        </li>
      ))}
    </ol>
  )
}

export function MfaRecoveryCodesDialog({
  open,
  mode,
  codes = [],
  status = null,
  newCodes = null,
  loading = false,
  error = null,
  onConfirm,
  onRegenerate,
  onDone,
  onOpenChange,
}: MfaRecoveryCodesDialogProps) {
  const t = useInternalT()
  const [confirmed, setConfirmed] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [view, setView] = useState<View>("status")
  const [confirmText, setConfirmText] = useState("")
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setConfirmed(false)
      setFeedback(null)
      setView("status")
      setConfirmText("")
      setLocalError(null)
    }
  }, [open])

  const shownCodes: readonly string[] = mode === "enroll" ? codes : (newCodes ?? [])
  const showNewCodes = mode === "manage" && newCodes !== null && newCodes.length === 10
  const remaining = status?.remaining ?? 0
  const total = status?.total ?? 10

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        recoveryCodesToTxt(shownCodes, t("internalAdmin.mfa.recovery.txtHeader")),
      )
      setFeedback(t("internalAdmin.mfa.recovery.copied"))
    } catch {
      setFeedback(t("internalAdmin.mfa.recovery.copyFailed"))
    }
  }

  const download = () => {
    try {
      const blob = new Blob([recoveryCodesToTxt(shownCodes, t("internalAdmin.mfa.recovery.txtHeader"))], {
        type: "text/plain;charset=utf-8",
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = t("internalAdmin.mfa.recovery.txtFile")
      anchor.click()
      URL.revokeObjectURL(url)
      setFeedback(t("internalAdmin.mfa.recovery.downloaded"))
    } catch {
      setFeedback(t("internalAdmin.mfa.recovery.downloadFailed"))
    }
  }

  const finish = async () => {
    if (!confirmed || loading || busy) return
    setBusy(true)
    try {
      await onConfirm?.()
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async () => {
    if (confirmText !== RECOVERY_CONFIRMATION || loading || busy) return
    setBusy(true)
    setLocalError(null)
    try {
      await onRegenerate?.(confirmText)
      setConfirmText("")
    } catch {
      setLocalError(t("internalAdmin.mfa.recovery.regenerationFailed"))
    } finally {
      setBusy(false)
    }
  }

  const visibleError = error ?? localError

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain p-5 sm:max-w-[520px] sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" aria-hidden="true" />
            {mode === "enroll"
              ? t("internalAdmin.mfa.recovery.enrollTitle")
              : t("internalAdmin.mfa.recovery.manageTitle")}
          </DialogTitle>
          <DialogDescription>
            {mode === "enroll"
              ? t("internalAdmin.mfa.recovery.enrollHint")
              : t("internalAdmin.mfa.recovery.manageHint")}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t("internalAdmin.mfa.recovery.loading")}
          </p>
        ) : null}

        {showNewCodes ? (
          <>
            <p className="text-xs font-medium text-foreground">
              {t("internalAdmin.mfa.recovery.newCodesTitle")}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {t("internalAdmin.mfa.recovery.newCodesHint")}
            </p>
            <CodesList codes={newCodes} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="min-h-11" onClick={() => void copy()}>
                <Copy className="size-4" aria-hidden="true" />
                {t("internalAdmin.mfa.recovery.copy")}
              </Button>
              <Button type="button" variant="outline" className="min-h-11" onClick={download}>
                <Download className="size-4" aria-hidden="true" />
                {t("internalAdmin.mfa.recovery.download")}
              </Button>
            </div>
          </>
        ) : mode === "enroll" ? (
          <>
            <CodesList codes={codes} />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={loading}
                onClick={() => void copy()}
              >
                <Copy className="size-4" aria-hidden="true" />
                {t("internalAdmin.mfa.recovery.copy")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={loading}
                onClick={download}
              >
                <Download className="size-4" aria-hidden="true" />
                {t("internalAdmin.mfa.recovery.download")}
              </Button>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-border/70 p-3">
              <Checkbox
                id="internal-recovery-confirmed"
                checked={confirmed}
                onCheckedChange={(value) => setConfirmed(value === true)}
                disabled={loading}
                aria-label={t("internalAdmin.mfa.recovery.confirmCheckbox")}
                className="mt-0.5 size-5"
              />
              <Label
                htmlFor="internal-recovery-confirmed"
                className="cursor-pointer text-xs font-normal leading-relaxed text-foreground"
              >
                {t("internalAdmin.mfa.recovery.confirmCheckbox")}
              </Label>
            </div>
          </>
        ) : view === "confirm" ? (
          <>
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
            >
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{t("internalAdmin.mfa.recovery.revokeWarning")}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="internal-recovery-confirmation" className="text-xs font-medium">
                {t("internalAdmin.mfa.recovery.confirmationLabel")}
              </Label>
              <Input
                id="internal-recovery-confirmation"
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                disabled={loading || busy}
                autoComplete="off"
                aria-label={t("internalAdmin.mfa.recovery.confirmationHint")}
                className="h-10 w-full font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                {t("internalAdmin.mfa.recovery.confirmationHint")}
              </p>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-medium tabular-nums text-foreground">
              {t("internalAdmin.mfa.recovery.remaining", { remaining, total })}
            </p>
            {status?.low ? (
              <p
                role="status"
                className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400"
              >
                <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
                {t("internalAdmin.mfa.recovery.lowBanner", { value: remaining })}
              </p>
            ) : null}
            <ol className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {(status?.codes ?? []).map((entry, index) => {
                const used = entry.used_at !== null
                return (
                  <li
                    key={entry.id}
                    className="flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs"
                  >
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {t("internalAdmin.mfa.recovery.codeItem", {
                        index: String(index + 1).padStart(2, "0"),
                      })}
                    </span>
                    {used ? (
                      <span className="min-w-0 truncate font-mono tabular-nums text-muted-foreground line-through">
                        <span>{t("internalAdmin.mfa.recovery.usedLabel")}</span>
                      </span>
                    ) : (
                      <span className="min-w-0 truncate font-mono tabular-nums text-foreground">
                        {t("internalAdmin.mfa.recovery.availableLabel")}
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
          </>
        )}

        {feedback !== null ? (
          <p aria-live="polite" className="text-[11px] text-muted-foreground">
            {feedback}
          </p>
        ) : null}

        {visibleError !== null ? (
          <p role="alert" className="text-xs font-medium text-destructive">
            {t("internalAdmin.mfa.recovery.error", { value: visibleError })}
          </p>
        ) : null}

        <DialogFooter className="mt-2 flex flex-row flex-wrap items-center justify-end gap-2 sm:space-x-0">
          {showNewCodes ? (
            <Button type="button" className="min-h-11" onClick={onDone}>
              {t("internalAdmin.mfa.recovery.done")}
            </Button>
          ) : mode === "enroll" ? (
            <Button
              type="button"
              className="min-h-11"
              disabled={!confirmed || loading || busy}
              onClick={() => void finish()}
            >
              {busy ? t("internalAdmin.actions.pending") : t("internalAdmin.mfa.recovery.done")}
            </Button>
          ) : view === "confirm" ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  setView("status")
                  setConfirmText("")
                  setLocalError(null)
                }}
              >
                {t("internalAdmin.actions.cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="min-h-11"
                disabled={confirmText !== RECOVERY_CONFIRMATION || loading || busy}
                onClick={() => void regenerate()}
              >
                {busy ? t("internalAdmin.actions.pending") : t("internalAdmin.mfa.recovery.confirmRegenerate")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              className="min-h-11"
              disabled={loading || busy || status === null}
              onClick={() => setView("confirm")}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {t("internalAdmin.mfa.recovery.regenerate")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
