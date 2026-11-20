import * as React from "react"
import { Eye, EyeOff, Loader2 } from "lucide-react"
import { Navigate, useNavigate, useSearchParams } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"

import { supabase } from "@/lib/supabase"
import { clearPendingPasswordSetup } from "@/lib/pending-password-setup"
import { RouteSkeleton } from "@/routes/route-skeleton"

import { AuthShell } from "@/components/shadcn/auth/auth-shell"
import { PasswordStrengthMeter } from "@/components/shadcn/auth/password-strength-meter"
import { Button } from "@/components/shadcn/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/shadcn/ui/field"
import { Input } from "@/components/shadcn/ui/input"

type SessionCheck = "checking" | "present" | "absent"

export function SetPasswordPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const origem = searchParams.get("origem") === "recuperacao" ? "recuperacao" : "convite"

  const [sessionCheck, setSessionCheck] = React.useState<SessionCheck>("checking")
  const [showPassword, setShowPassword] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let active = true
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return
        setSessionCheck(!error && data.session ? "present" : "absent")
      })
      .catch(() => {
        if (active) setSessionCheck("absent")
      })
    return () => {
      active = false
    }
  }, [])

  const schema = React.useMemo(
    () =>
      z.object({
        password: z
          .string()
          .min(1, t("auth.setPassword.errors.empty"))
          .min(6, t("auth.setPassword.errors.tooShort")),
      }),
    [t],
  )

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<{ password: string }>({
    resolver: zodResolver(schema),
    defaultValues: { password: "" },
    mode: "onBlur",
  })

  const passwordValue = watch("password") ?? ""

  const onSubmit = async (values: { password: string }) => {
    setServerError(null)
    try {
      const { error } = await supabase.auth.updateUser({ password: values.password })
      if (error) {
        const status = (error as { status?: number }).status
        const code = ((error as { code?: string }).code ?? "").toLowerCase()
        const message = (error.message ?? "").toLowerCase()

        if (status === 429 || code.includes("rate") || message.includes("rate")) {
          setServerError(t("auth.setPassword.errors.rateLimited"))
          return
        }
        if (
          code === "weak_password" ||
          message.includes("weak") ||
          message.includes("password should")
        ) {
          setServerError(t("auth.setPassword.errors.weak"))
          return
        }
        if (status === 401 || message.includes("session")) {
          setServerError(t("auth.setPassword.errors.sessionExpired"))
          // "1 leitura depois": o erro aparece e o redirect chega no próximo tick.
          window.setTimeout(() => {
            navigate("/link-expirado?motivo=sem-sessao", { replace: true })
          }, 0)
          return
        }
        if (
          message.includes("network") ||
          message.includes("fetch") ||
          message.includes("failed to fetch")
        ) {
          setServerError(t("auth.setPassword.errors.network"))
          return
        }
        setServerError(t("auth.setPassword.errors.generic"))
        return
      }

      clearPendingPasswordSetup()
      toast.success(t("auth.setPassword.successTitle"), {
        description: t("auth.setPassword.successDescription"),
      })
      navigate("/", { replace: true })
    } catch {
      setServerError(t("auth.setPassword.errors.network"))
    }
  }

  if (sessionCheck === "checking") {
    return <RouteSkeleton label={t("shell.verifyingSession")} />
  }

  if (sessionCheck === "absent") {
    return <Navigate to="/link-expirado?motivo=sem-sessao" replace />
  }

  const title =
    origem === "recuperacao" ? t("auth.setPassword.recoveryTitle") : t("auth.setPassword.inviteTitle")
  const subtitle =
    origem === "recuperacao"
      ? t("auth.setPassword.recoverySubtitle")
      : t("auth.setPassword.inviteSubtitle")

  return (
    <AuthShell contentClassName="max-w-md">
      <form className="flex flex-col gap-6" onSubmit={handleSubmit(onSubmit)} noValidate>
        <FieldGroup>
          <div className="flex flex-col items-center gap-1 text-center">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
            <p className="text-sm text-balance text-muted-foreground">{subtitle}</p>
          </div>

          {serverError ? (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {serverError}
            </div>
          ) : null}

          <Field>
            <FieldLabel htmlFor="new-password">{t("auth.setPassword.label")}</FieldLabel>
            <div className="relative">
              <Input
                id="new-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                autoFocus
                aria-invalid={!!errors.password}
                aria-describedby="new-password-hint"
                {...register("password")}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={
                  showPassword ? t("auth.hidePassword") : t("auth.showPassword")
                }
                aria-pressed={showPassword}
                className="absolute right-2 top-1/2 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showPassword ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <FieldDescription id="new-password-hint">{t("auth.setPassword.hint")}</FieldDescription>
            <FieldError id="new-password-error" errors={[errors.password]} />
            <PasswordStrengthMeter password={passwordValue} />
          </Field>

          <Field>
            <Button type="submit" disabled={isSubmitting} className="h-11 w-full font-semibold">
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  {t("auth.setPassword.saving")}
                </>
              ) : (
                t("auth.setPassword.submit")
              )}
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </AuthShell>
  )
}
