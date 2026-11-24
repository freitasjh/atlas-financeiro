/**
 * `/internal/mfa` — única superfície de enroll/verify de segundo fator
 * (REQ-17..REQ-19, UX §21).
 *
 * `InputOtp` de 6 dígitos, lockout de cliente visível, etapa 3 de códigos de
 * recuperação no enrollment e fallback de recuperação no desafio (ADR-001).
 */

import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { ShieldCheck } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"

import { Button } from "@/components/shadcn/ui/button"
import { Card, CardContent } from "@/components/shadcn/ui/card"
import { Input } from "@/components/shadcn/ui/input"
import { InputOtp } from "@/components/shadcn/ui/input-otp"
import { Label } from "@/components/shadcn/ui/label"
import {
  challengeInternalMfa,
  consumeRecoveryCode,
  enrollInternalTotp,
  listInternalMfaFactors,
  unenrollUnverifiedInternalTotpFactors,
  verifyInternalMfa,
  type InternalTotpEnrollment,
} from "@/internal/data/internal-client"
import { recoveryCodesService } from "@/internal/data/mfa-recovery-codes.service"
import {
  INITIAL_MFA_LOCKOUT,
  isMfaLockedOut,
  mfaLockoutRemainingMs,
  registerMfaFailure,
  registerMfaSuccess,
  MFA_LOCKOUT_THRESHOLD,
  type MfaLockoutState,
} from "@/internal/guard/operator-gate"
import { useInternalOperator } from "@/internal/guard/use-internal-operator"
import { InternalBlankLayout } from "@/internal/shell/internal-blank-layout"
import { MfaRecoveryChallenge } from "@/internal/ui/mfa-recovery-challenge"
import { MfaRecoveryCodesDialog } from "@/internal/ui/mfa-recovery-codes-dialog"
import { useInternalT } from "../ui/use-internal-t"

const CODE_LENGTH = 6

type Phase = "loading" | "ready" | "failed"

interface BootstrapOutcome {
  enrollment: InternalTotpEnrollment | null
  factorId: string
  challengeId: string
}

async function bootstrapInternalMfa(): Promise<BootstrapOutcome> {
  const factors = await listInternalMfaFactors()
  const verified = factors.find((factor) => factor.status === "verified")
  if (verified !== undefined) {
    const challengeId = await challengeInternalMfa(verified.id)
    return { enrollment: null, factorId: verified.id, challengeId }
  }

  // Fator unverified (inclusive o legado com friendly_name vazio) não serve
  // para challenge: descartá-lo antes do enroll evita o 422 do GoTrue.
  await unenrollUnverifiedInternalTotpFactors(factors)
  const created = await enrollInternalTotp()
  const challengeId = await challengeInternalMfa(created.factorId)
  return { enrollment: created, factorId: created.factorId, challengeId }
}

export function InternalMfaPage() {
  const t = useInternalT()
  const navigate = useNavigate()
  const reset = useInternalOperator((store) => store.reset)
  const verify = useInternalOperator((store) => store.verify)

  const [phase, setPhase] = useState<Phase>("loading")
  const [enrollment, setEnrollment] = useState<InternalTotpEnrollment | null>(null)
  const [challengeId, setChallengeId] = useState<string | null>(null)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lockout, setLockout] = useState<MfaLockoutState>(INITIAL_MFA_LOCKOUT)
  const [now, setNow] = useState(() => Date.now())
  // `attempt` identifica o bootstrap. StrictMode repete mount → cleanup → mount
  // com o MESMO attempt e reusa a promessa em cache (nenhum POST duplicado);
  // o retry explícito incrementa attempt e cria uma nova execução.
  const [attempt, setAttempt] = useState(0)
  const bootstrapRef = useRef<{ attempt: number; promise: Promise<BootstrapOutcome> } | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false)
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [generatingCodes, setGeneratingCodes] = useState(false)

  useEffect(() => {
    let active = true
    let run = bootstrapRef.current
    if (run === null || run.attempt !== attempt) {
      run = { attempt, promise: bootstrapInternalMfa() }
      bootstrapRef.current = run
    }

    run.promise.then(
      (outcome) => {
        if (!active) return
        setEnrollment(outcome.enrollment)
        setFactorId(outcome.factorId)
        setChallengeId(outcome.challengeId)
        setPhase("ready")
      },
      () => {
        if (active) setPhase("failed")
      },
    )

    return () => {
      active = false
    }
  }, [attempt])

  useEffect(() => {
    if (!isMfaLockedOut(lockout, now)) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [lockout, now])

  const finish = async () => {
    reset()
    await verify({ force: true })
    navigate("/internal", { replace: true })
  }

  const submit = async (value: string) => {
    if (factorId === null || challengeId === null) return
    if (isMfaLockedOut(lockout, Date.now())) return
    if (value.length !== CODE_LENGTH) return

    setPending(true)
    setError(null)
    try {
      const result = await verifyInternalMfa({ factorId, challengeId, code: value })
      if (!result.ok) {
        const next = registerMfaFailure(lockout, Date.now())
        setLockout(next)
        setCode("")
        setError(
          isMfaLockedOut(next, Date.now())
            ? t("internalAdmin.mfa.locked")
            : t("internalAdmin.mfa.invalidCode", {
                value: MFA_LOCKOUT_THRESHOLD - next.failures,
              }),
        )
        return
      }

      setLockout(registerMfaSuccess())

      // Primeiro enrollment: a lista nasce pela Edge e aparece UMA vez. Sem ela
      // o fluxo não conclui (RF-01/RF-04). Login com fator já verificado segue
      // direto — nenhuma lista nova é gerada.
      if (enrollment !== null) {
        setGeneratingCodes(true)
        try {
          const generated = await recoveryCodesService.generate()
          if (!generated.ok) {
            setError(t("internalAdmin.mfa.recovery.enrollmentUnavailable"))
            return
          }
          setRecoveryCodes([...generated.data.codes])
          setRecoveryError(null)
          setRecoveryDialogOpen(true)
        } finally {
          setGeneratingCodes(false)
        }
        return
      }

      await finish()
    } catch {
      setError(t("internalAdmin.mfa.invalidCode", { value: MFA_LOCKOUT_THRESHOLD - lockout.failures }))
    } finally {
      setPending(false)
    }
  }

  const locked = isMfaLockedOut(lockout, now)
  const remainingSeconds = Math.ceil(mfaLockoutRemainingMs(lockout, now) / 1000)

  return (
    <InternalBlankLayout>
      <Card className="border-border/70 shadow-xs">
        <CardContent className="flex flex-col gap-5 p-5 sm:p-6">
          <div className="flex flex-col gap-1">
            <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight text-foreground">
              <ShieldCheck className="size-5" aria-hidden="true" />
              {t("internalAdmin.mfa.title")}
            </h1>
            <p className="text-xs text-muted-foreground">{t("internalAdmin.mfa.hint")}</p>
          </div>

          {phase === "loading" ? (
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {t("internalAdmin.mfa.preparing")}
            </p>
          ) : null}

          {phase === "failed" ? (
            <div role="alert" className="flex flex-col gap-2">
              <p className="text-xs font-medium text-destructive">{t("internalAdmin.mfa.unavailable")}</p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  setPhase("loading")
                  setCode("")
                  setError(null)
                  setAttempt((current) => current + 1)
                }}
              >
                {t("internalAdmin.mfa.retry")}
              </Button>
            </div>
          ) : null}

          {phase === "ready" ? (
            <>
              {enrollment !== null ? (
                <div className="flex flex-col items-center gap-2">
                  <span className="text-xs font-medium text-foreground">
                    {t("internalAdmin.mfa.qrLabel")}
                  </span>
                  <div className="rounded-lg border border-border/70 bg-card p-3">
                    <QRCodeSVG
                      value={enrollment.uri}
                      size={176}
                      marginSize={4}
                      title={t("internalAdmin.mfa.qrAlt")}
                      aria-describedby="internal-mfa-qr-hint"
                      className="h-auto w-full max-w-[176px]"
                    />
                  </div>
                  <p
                    id="internal-mfa-qr-hint"
                    className="text-center text-[11px] text-muted-foreground"
                  >
                    {t("internalAdmin.mfa.qrHint")}
                  </p>
                </div>
              ) : null}

              {enrollment !== null ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="internal-mfa-secret" className="text-xs font-medium">
                    {t("internalAdmin.mfa.manualKey")}
                  </Label>
                  <Input
                    id="internal-mfa-secret"
                    readOnly
                    value={enrollment.secret}
                    className="h-10 w-full font-mono text-xs tabular-nums"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <p className="text-[11px] text-muted-foreground">{t("internalAdmin.mfa.manualKeyHint")}</p>
                </div>
              ) : null}

              {!recoveryMode ? (
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-foreground">
                    {t("internalAdmin.mfa.codeLabel")}
                  </span>
                  <InputOtp
                    id="internal-mfa-code"
                    name="internal-mfa-code"
                    length={CODE_LENGTH}
                    value={code}
                    onChange={setCode}
                    onComplete={(value) => void submit(value)}
                    disabled={pending || generatingCodes || locked}
                    isInvalid={error !== null}
                    autoFocus
                  />
                </div>
              ) : null}

              {locked ? (
                <p role="alert" className="text-xs font-medium text-destructive tabular-nums">
                  {t("internalAdmin.mfa.lockedCountdown", { seconds: remainingSeconds })}
                </p>
              ) : null}

              {!locked && error !== null ? (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {error}
                </p>
              ) : null}

              {!recoveryMode ? (
                <Button
                  type="button"
                  className="min-h-11 w-full"
                  disabled={pending || generatingCodes || locked || code.length !== CODE_LENGTH}
                  onClick={() => void submit(code)}
                >
                  {pending || generatingCodes
                    ? t("internalAdmin.actions.pending")
                    : t("internalAdmin.mfa.submit")}
                </Button>
              ) : null}

              <MfaRecoveryChallenge
                onConsume={consumeRecoveryCode}
                onSuccess={() => void finish()}
                onOpenChange={setRecoveryMode}
                disabled={pending || generatingCodes || locked}
              />
            </>
          ) : null}
        </CardContent>
        <MfaRecoveryCodesDialog
          open={recoveryDialogOpen}
          mode="enroll"
          codes={recoveryCodes ?? []}
          error={recoveryError}
          onConfirm={() => {
            setRecoveryDialogOpen(false)
            return finish()
          }}
        />
      </Card>
    </InternalBlankLayout>
  )
}
