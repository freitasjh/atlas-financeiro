import { useEffect, type ReactNode } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/shadcn/ui/button"
import { RouteSkeleton } from "@/routes/route-skeleton"
import { hasPendingPasswordSetupFor, readPendingPasswordSetupOrigin } from "@/lib/pending-password-setup"
import { useAuthStore } from "@/store/auth-store"

function useGuardEffect(): void {
  const initialized = useAuthStore((s) => s.initialized)
  const init = useAuthStore((s) => s.init)
  useEffect(() => {
    if (!initialized) void init()
  }, [initialized, init])
}

function GuardErrorState() {
  const { t } = useTranslation()
  const error = useAuthStore((s) => s.error)
  const retryInit = useAuthStore((s) => s.retryInit)
  return (
    <div
      role="alert"
      className="flex min-h-svh w-full flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <h2 className="text-lg font-semibold text-foreground">
        {t("shell.guardErrorTitle")}
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {error ?? t("shell.guardErrorFallback")} {t("shell.guardErrorHint")}
      </p>
      <Button type="button" onClick={() => retryInit()}>
        {t("common.retry")}
      </Button>
    </div>
  )
}

export function RequireSession({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  const initialized = useAuthStore((s) => s.initialized)
  const location = useLocation()
  useGuardEffect()

  if (!initialized || status === "idle" || status === "loading") {
    return <RouteSkeleton />
  }

  if (status === "error") {
    return <GuardErrorState />
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  // Convite/recovery ainda sem senha salva: o onboarding manda na navegação.
  const pendingPasswordSetup =
    typeof document !== "undefined" && hasPendingPasswordSetupFor(document.cookie, user.id)
  if (pendingPasswordSetup) {
    const origem = readPendingPasswordSetupOrigin(document.cookie) ?? "convite"
    return <Navigate to={`/definir-senha?origem=${origem}`} replace />
  }

  return <>{children}</>
}
