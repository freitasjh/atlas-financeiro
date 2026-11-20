/**
 * `/internal/acesso-negado` — tela de **estado**, não de produto (REQ-15).
 *
 * DOM sem papel, tenant, e-mail, documento ou UUID: só a copy fixa e dois
 * caminhos. `denied` não faz `signOut` — a sessão de tenant sobrevive.
 *
 * Retry bem-sucedido **sai** da tela: sem isso o hash continuava em
 * `/internal/acesso-negado` com veredito `operator` e nenhum feedback (re-H3 F4).
 */

import { useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"

import { Button } from "@/components/shadcn/ui/button"
import { Card, CardContent } from "@/components/shadcn/ui/card"
import {
  ONBOARDING_ERROR_SEARCH,
  sanitizeReturnTo,
} from "@/internal/guard/resolve-onboarding"
import { useInternalOperator } from "@/internal/guard/use-internal-operator"
import { InternalBlankLayout } from "@/internal/shell/internal-blank-layout"
import { useInternalT } from "../ui/use-internal-t"

export function InternalDeniedPage() {
  const t = useInternalT()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const verify = useInternalOperator((store) => store.verify)
  const isError = `?${searchParams.toString()}` === ONBOARDING_ERROR_SEARCH
  const retorno = sanitizeReturnTo(searchParams.get("retorno"))
  const [retrying, setRetrying] = useState(false)
  const [stillDenied, setStillDenied] = useState(false)

  const retry = async () => {
    setRetrying(true)
    setStillDenied(false)
    try {
      const next = await verify({ force: true })
      if (next === "operator") {
        navigate(retorno, { replace: true })
        return
      }
      setStillDenied(true)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <InternalBlankLayout>
      <Card className="border-border/70 shadow-xs">
        <CardContent className="flex flex-col gap-4 p-6 text-center">
          <div
            role={isError ? "alert" : "status"}
            className="flex flex-col items-center gap-2"
          >
            <h1 className="text-lg font-bold tracking-tight text-foreground">
              {isError ? t("internalGuard.errorTitle") : t("internalGuard.deniedTitle")}
            </h1>
            <p className="max-w-sm text-sm text-muted-foreground">
              {isError ? t("internalGuard.errorBody") : t("internalGuard.deniedBody")}
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Button
              type="button"
              className="min-h-11"
              disabled={retrying}
              onClick={() => void retry()}
            >
              {retrying ? t("internalGuard.checking") : t("internalGuard.retry")}
            </Button>
            <Button asChild variant="outline" className="min-h-11">
              <Link to="/">{t("internalGuard.backToApp")}</Link>
            </Button>
          </div>

          {retrying ? (
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {t("internalGuard.checking")}
            </p>
          ) : null}

          {!retrying && stillDenied ? (
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {t("internalGuard.retryDenied")}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </InternalBlankLayout>
  )
}
