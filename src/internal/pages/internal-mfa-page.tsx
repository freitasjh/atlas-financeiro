/**
 * `/internal/mfa` — única superfície de enroll/verify de segundo fator
 * (REQ-17..REQ-19, UX §21).
 *
 * `InputOtp` de 6 dígitos, lockout de cliente visível e **sem** códigos de
 * recuperação: O6 não foi implementado, então não se promete o que não existe.
 */

import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { ShieldCheck } from "lucide-react"

import { Button } from "@/components/shadcn/ui/button"
import { Card, CardContent } from "@/components/shadcn/ui/card"
import { Input } from "@/components/shadcn/ui/input"
import { InputOtp } from "@/components/shadcn/ui/input-otp"
import { Label } from "@/components/shadcn/ui/label"
import {
  challengeInternalMfa,
  enrollInternalTotp,
  listInternalMfaFactors,
  verifyInternalMfa,
  type InternalTotpEnrollment,
} from "@/internal/data/internal-client"
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
import { useInternalT } from "../ui/use-internal-t"

const CODE_LENGTH = 6

type Phase = "loading" | "ready" | "failed"

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
  // Reinício idempotente: StrictMode replaya mount → cleanup → mount, e um ref
  // "já iniciou" bloquearia o segundo mount para sempre (H3 P1). Cada `attempt`
  // roda o bootstrap do zero, com o `active` local descartando o run antigo.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    const bootstrap = async () => {
      try {
        const factors = await listInternalMfaFactors()
        const verified = factors.find((factor) => factor.status === "verified")
        if (verified !== undefined) {
          const id = await challengeInternalMfa(verified.id)
          if (!active) return
          setFactorId(verified.id)
          setChallengeId(id)
          setPhase("ready")
          return
        }

        const created = await enrollInternalTotp()
        const id = await challengeInternalMfa(created.factorId)
        if (!active) return
        setEnrollment(created)
        setFactorId(created.factorId)
        setChallengeId(id)
        setPhase("ready")
      } catch {
        if (active) setPhase("failed")
      }
    }

    void bootstrap()
    return () => {
      active = false
    }
  }, [attempt])

  useEffect(() => {
    if (!isMfaLockedOut(lockout, now)) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [lockout, now])

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
      reset()
      await verify({ force: true })
      navigate("/internal", { replace: true })
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

              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-foreground">{t("internalAdmin.mfa.codeLabel")}</span>
                <InputOtp
                  id="internal-mfa-code"
                  name="internal-mfa-code"
                  length={CODE_LENGTH}
                  value={code}
                  onChange={setCode}
                  onComplete={(value) => void submit(value)}
                  disabled={pending || locked}
                  isInvalid={error !== null}
                  autoFocus
                />
              </div>

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

              <Button
                type="button"
                className="min-h-11 w-full"
                disabled={pending || locked || code.length !== CODE_LENGTH}
                onClick={() => void submit(code)}
              >
                {pending ? t("internalAdmin.actions.pending") : t("internalAdmin.mfa.submit")}
              </Button>
            </>
          ) : null}
        </CardContent>
      </Card>
    </InternalBlankLayout>
  )
}
