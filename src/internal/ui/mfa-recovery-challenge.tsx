/**
 * Fallback "Usar código de recuperação" do desafio `/internal/mfa` (UI-02).
 *
 * Erro é não bloqueante: foco volta ao campo, contador de tentativas aparece
 * quando a RPC o fornece e `/internal` só é liberado pelo `onSuccess` — chamado
 * depois que o cliente confirmou `aal==='aal2'` no token renovado.
 */

import { useEffect, useRef, useState } from "react"
import { KeyRound } from "lucide-react"

import { Button } from "@/components/shadcn/ui/button"
import { Input } from "@/components/shadcn/ui/input"
import { Label } from "@/components/shadcn/ui/label"
import { normalizeRecoveryCode, type RecoveryConsumeOutcome } from "@/internal/data/mfa-recovery-codes"

export type { RecoveryConsumeOutcome }
import { useInternalT } from "./use-internal-t"

export interface MfaRecoveryChallengeProps {
  onConsume: (code: string) => Promise<RecoveryConsumeOutcome>
  onSuccess: () => void | Promise<void>
  /** Avisa a página para ocultar o TOTP enquanto o fallback está aberto. */
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
}

const SHAKE_CSS = `@keyframes mfa-recovery-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}`

export function MfaRecoveryChallenge({
  onConsume,
  onSuccess,
  onOpenChange,
  disabled = false,
}: MfaRecoveryChallengeProps) {
  const t = useInternalT()
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempts, setAttempts] = useState<number | null>(null)
  const [shake, setShake] = useState(0)

  // O campo fica desabilitado durante o pedido: focar dentro do handler não
  // funciona. Focar depois do commit, com o campo já reabilitado (RF-10).
  useEffect(() => {
    if (open && error !== null && !pending) inputRef.current?.focus()
  }, [open, error, pending])

  const messageFor = (label: string): string => {
    if (label === "mfa-recovery-code-invalid" || label === "mfa-recovery-code-used") {
      return t("internalAdmin.mfa.recovery.challenge.invalidOrUsed")
    }
    if (label === "mfa-recovery-locked") {
      return t("internalAdmin.mfa.recovery.challenge.locked")
    }
    if (label === "mfa-recovery-aal-promotion-failed") {
      return t("internalAdmin.mfa.recovery.challenge.promotionFailed")
    }
    if (label === "mfa-recovery-session-mismatch") {
      return t("internalAdmin.mfa.recovery.challenge.sessionMismatch")
    }
    return t("internalAdmin.mfa.recovery.challenge.genericError")
  }

  const submit = async () => {
    if (pending || disabled || value.length === 0) return
    setPending(true)
    setError(null)
    setAttempts(null)
    try {
      const outcome = await onConsume(normalizeRecoveryCode(value))
      if (outcome.ok) {
        await onSuccess()
        return
      }
      setError(messageFor(outcome.error))
      setAttempts(outcome.attempts_remaining ?? null)
      if (outcome.retry_after_seconds !== undefined) {
        setError(
          t("internalAdmin.mfa.recovery.challenge.lockedRetry", {
            minutes: Math.max(1, Math.ceil(outcome.retry_after_seconds / 60)),
          }),
        )
      }
      setShake((current) => current + 1)
      inputRef.current?.focus()
    } catch {
      setError(t("internalAdmin.mfa.recovery.challenge.genericError"))
      inputRef.current?.focus()
    } finally {
      setPending(false)
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="link"
        className="min-h-11 w-full text-xs"
        disabled={disabled}
        onClick={() => {
          setOpen(true)
          onOpenChange?.(true)
        }}
      >
        <KeyRound className="size-4" aria-hidden="true" />
        {t("internalAdmin.mfa.recovery.challenge.fallbackLink")}
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/30 p-3">
      <style>{SHAKE_CSS}</style>
      <Label htmlFor="internal-recovery-code" className="text-xs font-medium text-foreground">
        {t("internalAdmin.mfa.recovery.challenge.codeLabel")}
      </Label>
      <p className="text-[11px] text-muted-foreground">
        {t("internalAdmin.mfa.recovery.challenge.codeHint")}
      </p>
      <div style={shake > 0 ? { animation: "mfa-recovery-shake 240ms ease-in-out" } : undefined}>
        <Input
          ref={inputRef}
          id="internal-recovery-code"
          name="internal-recovery-code"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={pending || disabled}
          inputMode="text"
          autoComplete="one-time-code"
          spellCheck={false}
          aria-invalid={error !== null}
          aria-label={t("internalAdmin.mfa.recovery.challenge.codeLabel")}
          className="h-10 w-full font-mono text-xs tabular-nums"
        />
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
      {attempts !== null ? (
        <p aria-live="polite" className="text-[11px] tabular-nums text-muted-foreground">
          {t("internalAdmin.mfa.recovery.challenge.attempts", { value: attempts })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="min-h-11 flex-1"
          disabled={pending || disabled || value.length === 0}
          onClick={() => void submit()}
        >
          {pending ? t("internalAdmin.actions.pending") : t("internalAdmin.mfa.recovery.challenge.submit")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={pending}
          onClick={() => {
            setOpen(false)
            onOpenChange?.(false)
            setValue("")
            setError(null)
            setAttempts(null)
          }}
        >
          {t("internalAdmin.actions.cancel")}
        </Button>
      </div>
    </div>
  )
}
