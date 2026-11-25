import * as React from "react"
import { useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { useTranslation } from "react-i18next"

import { RouteSkeleton } from "@/routes/route-skeleton"

import { currentSession } from "@/session/session"
import { useAuthStore } from "@/store/auth-store"
import { AuthShell } from "@/components/shadcn/auth/auth-shell"
import { ForgotPasswordForm } from "@/components/shadcn/auth/forgot-password-form"
import { LoginForm } from "@/components/shadcn/auth/login-form"
import { resolveLoginRedirect } from "@/pages/login-redirect"

export function LoginPage() {
  const [checking, setChecking] = React.useState(true)
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const initialized = useAuthStore((s) => s.initialized)
  const init = useAuthStore((s) => s.init)
  const reLoginRequired = useAuthStore((s) => s.reLoginRequired)
  const redirectTo = resolveLoginRedirect(location.state?.from)
  const recovering = searchParams.get("modo") === "recuperar"

  React.useEffect(() => {
    let active = true
    void Promise.resolve(initialized ? undefined : init())
      .then(() => {
        if (!active) return
        if (currentSession() && useAuthStore.getState().status === "authenticated") {
          navigate(redirectTo.replace(/^#/, ""), { replace: true })
          return
        }
        setChecking(false)
      })
      .catch(() => {
        if (active) setChecking(false)
      })
    return () => {
      active = false
    }
  }, [init, initialized, navigate, redirectTo])

  if (checking) {
    return <RouteSkeleton label={t("shell.verifyingSession")} />
  }

  return (
    <AuthShell>
      {reLoginRequired && !recovering ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-muted bg-muted/30 p-3 text-sm text-foreground"
        >
          {t("auth.reLoginRequired")}
        </div>
      ) : null}
      {recovering ? (
        <ForgotPasswordForm />
      ) : (
        <LoginForm redirectTo={redirectTo} forgotPasswordHref="/login?modo=recuperar" />
      )}
    </AuthShell>
  )
}
