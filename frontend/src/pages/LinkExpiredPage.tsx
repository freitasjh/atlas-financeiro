import { ClockAlert, Link2Off } from "lucide-react"
import { Link, useSearchParams } from "react-router-dom"
import { useTranslation } from "react-i18next"

import { AuthShell } from "@/components/shadcn/auth/auth-shell"
import { Button } from "@/components/shadcn/ui/button"

const REASONS = ["expirado", "consumido", "invalido", "sem-sessao"] as const
type LinkErrorReason = (typeof REASONS)[number]

// `consumido` fica no contrato da rota (SPEC §4) para links antigos/manuais: a
// ponte atual (`auth-hash-intent`) classifica expirado/invalido e nunca emite
// `consumido`, então é copy alcançável apenas por URL direta — não é dead code
// enquanto o contrato público listar o motivo.
const COPY_KEYS: Record<
  LinkErrorReason,
  { title: string; body: string }
> = {
  expirado: { title: "auth.linkError.expiredTitle", body: "auth.linkError.expiredBody" },
  consumido: { title: "auth.linkError.consumedTitle", body: "auth.linkError.consumedBody" },
  invalido: { title: "auth.linkError.invalidTitle", body: "auth.linkError.invalidBody" },
  "sem-sessao": { title: "auth.linkError.noSessionTitle", body: "auth.linkError.noSessionBody" },
}

export function resolveLinkErrorReason(value: string | null): LinkErrorReason {
  return (REASONS as readonly string[]).includes(value ?? "")
    ? (value as LinkErrorReason)
    : "invalido"
}

export function LinkExpiredPage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const reason = resolveLinkErrorReason(searchParams.get("motivo"))
  const copy = COPY_KEYS[reason]
  const Icon = reason === "expirado" || reason === "sem-sessao" ? ClockAlert : Link2Off

  return (
    <AuthShell contentClassName="max-w-md" chrome={false}>
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Icon className="size-6" aria-hidden="true" />
        </div>

        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t(copy.title)}</h1>
          <p className="text-sm text-balance text-muted-foreground">{t(copy.body)}</p>
        </div>

        <Button asChild className="h-11 w-full font-semibold">
          <Link to="/login" replace>
            {t("auth.linkError.cta")}
          </Link>
        </Button>

        <p className="text-xs text-muted-foreground">{t("auth.linkError.auxiliary")}</p>
      </div>
    </AuthShell>
  )
}
