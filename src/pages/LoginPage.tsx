import * as React from "react"
import { useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { useTranslation } from "react-i18next"

import { RouteSkeleton } from "@/routes/route-skeleton"

import { supabase } from "@/lib/supabase"
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
  const redirectTo = resolveLoginRedirect(location.state?.from)
  const recovering = searchParams.get("modo") === "recuperar"

  React.useEffect(() => {
    let active = true
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return
        if (error) {
          setChecking(false)
          return
        }
        if (data.session) {
          navigate(redirectTo.replace(/^#/, ""), { replace: true })
        } else {
          setChecking(false)
        }
      })
      .catch(() => {
        if (!active) return
        setChecking(false)
      })
    return () => {
      active = false
    }
  }, [navigate, redirectTo])

  if (checking) {
    return <RouteSkeleton label={t("shell.verifyingSession")} />
  }

  return (
    <AuthShell>
      {recovering ? (
        <ForgotPasswordForm />
      ) : (
        <LoginForm redirectTo={redirectTo} forgotPasswordHref="/login?modo=recuperar" />
      )}
    </AuthShell>
  )
}
