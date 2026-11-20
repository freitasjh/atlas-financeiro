import { useEffect, type ReactNode } from "react"
import { Navigate } from "react-router-dom"
import { useTranslation } from "react-i18next"

import {
  firstAccessPath,
  INTERNAL_DENIED_PATH,
  INTERNAL_HOME_PATH,
  INTERNAL_LOGIN_PATH,
  INTERNAL_MFA_PATH,
  ONBOARDING_ERROR_SEARCH,
} from "./resolve-onboarding"
import { useInternalOperator } from "./use-internal-operator"

export interface RequireInternalOperatorProps {
  children: ReactNode
  /** Só a superfície de enroll (`/internal/mfa`) monta com `mfa-required`. */
  allowMfaRequired?: boolean
}

/**
 * Guard do control plane. `children` montam **somente** em `operator`
 * (exceto a superfície declarada de enroll MFA). `unknown` nunca renderiza;
 * `checking` mostra esqueleto — nunca o conteúdo anterior.
 */
export function RequireInternalOperator({
  children,
  allowMfaRequired = false,
}: RequireInternalOperatorProps) {
  const { t } = useTranslation()
  const state = useInternalOperator((store) => store.state)
  const verify = useInternalOperator((store) => store.verify)

  useEffect(() => {
    if (state === "unknown") void verify()
  }, [state, verify])

  if (state === "unknown") return null

  if (state === "checking") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-svh items-center justify-center p-6"
      >
        <p className="text-sm text-muted-foreground">{t("internalGuard.checking")}</p>
      </div>
    )
  }

  if (state === "operator") return <>{children}</>

  if (state === "first-access") {
    return <Navigate to={firstAccessPath(INTERNAL_HOME_PATH)} replace />
  }

  if (state === "mfa-required") {
    if (allowMfaRequired) return <>{children}</>
    return <Navigate to={INTERNAL_MFA_PATH} replace />
  }

  if (state === "unauthenticated") return <Navigate to={INTERNAL_LOGIN_PATH} replace />

  // `denied` é superfície terminal (REQ-14): navega para a tela de estado em
  // vez de renderizar o veredito inline no hash atual (H3 P3).
  if (state === "denied") return <Navigate to={INTERNAL_DENIED_PATH} replace />

  // `error` também é superfície terminal (SPEC §3.2/§3.3 linha 5): a tela de
  // estado em `?motivo=indisponivel` é quem oferece o retry — nada de UI inline
  // duplicada aqui.
  return <Navigate to={`${INTERNAL_DENIED_PATH}${ONBOARDING_ERROR_SEARCH}`} replace />
}
