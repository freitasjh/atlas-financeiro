import { useSearchParams } from "react-router-dom"

import { SignupForm } from "@/components/auth/SignupForm"
import { AuthShell } from "@/components/shadcn/auth/auth-shell"

/** Superfície pública de cadastro (`/register` e `/signup`). Sem wizard/social/selos. */
export function PublicSignupPage() {
  const [searchParams] = useSearchParams()
  return (
    <AuthShell contentClassName="max-w-sm lg:max-w-md">
      <SignupForm plano={searchParams.get("plano")} />
    </AuthShell>
  )
}
