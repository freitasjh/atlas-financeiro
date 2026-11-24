/**
 * `/internal/login` — acesso do operador (UX §21: `AuthShell`, sem cadastro e
 * sem social). Reusa a gramática pública de auth; não é a `LoginPage` de tenant.
 */

import { useState, type FormEvent } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"

import { AuthShell } from "@/components/shadcn/auth/auth-shell"
import { Button } from "@/components/shadcn/ui/button"
import { Input } from "@/components/shadcn/ui/input"
import { Label } from "@/components/shadcn/ui/label"
import { signInInternalOperator } from "@/internal/data/internal-client"
import { sanitizeReturnTo } from "@/internal/guard/resolve-onboarding"
import { useInternalOperator } from "@/internal/guard/use-internal-operator"
import { useInternalT } from "../ui/use-internal-t"

export function InternalLoginPage() {
  const t = useInternalT()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const retorno = sanitizeReturnTo(searchParams.get("retorno"))
  const reset = useInternalOperator((store) => store.reset)
  const verify = useInternalOperator((store) => store.verify)

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const result = await signInInternalOperator(email.trim(), password)
      if (!result.ok) {
        setError(t("internalAdmin.invalidCredentials"))
        return
      }
      reset()
      await verify({ force: true })
      navigate(retorno, { replace: true })
    } catch {
      setError(t("internalAdmin.invalidCredentials"))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthShell>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-bold tracking-tight text-foreground">
            {t("internalAdmin.loginTitle")}
          </h1>
          <p className="text-xs text-muted-foreground">{t("internalAdmin.loginHint")}</p>
        </div>

        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="internal-email" className="text-xs font-medium">
              {t("internalAdmin.loginEmail")}
            </Label>
            <Input
              id="internal-email"
              type="email"
              autoComplete="username"
              required
              aria-required="true"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-10 w-full"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="internal-password" className="text-xs font-medium">
              {t("internalAdmin.loginPassword")}
            </Label>
            <Input
              id="internal-password"
              type="password"
              autoComplete="current-password"
              required
              aria-required="true"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-10 w-full"
            />
          </div>

          {error !== null ? (
            <p role="alert" className="text-xs font-medium text-destructive">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="min-h-11 w-full" disabled={pending}>
            {pending ? t("internalAdmin.actions.pending") : t("internalAdmin.signIn")}
          </Button>
        </form>
      </div>
    </AuthShell>
  )
}
