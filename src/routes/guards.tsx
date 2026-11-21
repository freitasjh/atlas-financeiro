import { useEffect, useState, type ReactNode } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/shadcn/ui/button"
import { RouteSkeleton } from "@/routes/route-skeleton"
import { hasPendingPasswordSetupFor, readPendingPasswordSetupOrigin } from "@/lib/pending-password-setup"
import { useAuthStore } from "@/store/auth-store"
import { supabase } from "@/lib/supabase"

interface GuardUser {
  id: string
  role?: string | null
}

interface ResolvedRole {
  userId: string
  role: string | null
}

function useGuardEffect(): void {
  const initialized = useAuthStore((s) => s.initialized)
  const init = useAuthStore((s) => s.init)
  useEffect(() => {
    if (!initialized) void init()
  }, [initialized, init])
}

function canQueryProfileRole(): boolean {
  return typeof (supabase as { from?: unknown }).from === "function"
}

/**
 * Lê `public.profiles.role` tolerando as formas do builder do Supabase
 * (`.single()`, `.maybeSingle()` ou thenable). Nunca lança: falha de leitura
 * devolve `null` e o guard segue com o comportamento de usuário comum.
 */
async function loadProfileRole(userId: string): Promise<string | null> {
  try {
    const client = supabase as { from?: (table: string) => any }
    const query = client.from?.("profiles")?.select("role")?.eq("id", userId)
    if (!query) return null

    let result: any = null
    if (typeof query.single === "function") {
      result = await query.single()
    } else if (typeof query.maybeSingle === "function") {
      result = await query.maybeSingle()
    } else if (typeof query.then === "function") {
      result = await query
    }

    const data = result?.data ?? result
    const role = Array.isArray(data) ? data[0]?.role : data?.role
    return typeof role === "string" ? role : null
  } catch {
    return null
  }
}

/**
 * Papel efetivo do usuário + flag de "ainda resolvendo".
 *
 * O ponto crítico é `pending` ser **derivado no render**, e não guardado num
 * estado que só o efeito atualiza. Se dependêssemos de `setRoleResolved(false)`
 * dentro do efeito, a renderização em que `user` aparece (login) ainda via
 * `roleResolved === true` do initializer com `user === null` e renderizava o
 * tenant por um frame antes da consulta — o super_admin ficava no dashboard.
 *
 * Mantemos o resultado da consulta atrelado ao `userId`: troca de conta nunca
 * reaproveita o papel da sessão anterior.
 */
function useGuardRole(user: GuardUser | null): { role: string | null | undefined; pending: boolean } {
  const [fetched, setFetched] = useState<ResolvedRole | null>(null)
  const canQuery = canQueryProfileRole()

  const storeRole = user?.role
  const fetchedRole = user && fetched?.userId === user.id ? fetched.role : undefined
  const role = storeRole !== undefined && storeRole !== null ? storeRole : fetchedRole
  const pending = !!user && role === undefined && canQuery

  useEffect(() => {
    if (!user || (user.role !== undefined && user.role !== null) || !canQuery) return
    let cancelled = false
    void loadProfileRole(user.id).then((loadedRole) => {
      if (!cancelled) setFetched({ userId: user.id, role: loadedRole })
    })
    return () => {
      cancelled = true
    }
  }, [user?.id, user?.role, canQuery])

  return { role, pending }
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
  const { role, pending: rolePending } = useGuardRole(user)

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

  // Super_admin nunca renderiza o tenant: enquanto o papel não é conhecido,
  // mostra skeleton; quando resolvido, vai para o control plane. O guard de
  // `/internal` decide first-access/MFA (Edge verify-operator).
  if (rolePending) {
    return <RouteSkeleton />
  }

  if (role === "super_admin") {
    return <Navigate to="/internal" replace />
  }

  return <>{children}</>
}
