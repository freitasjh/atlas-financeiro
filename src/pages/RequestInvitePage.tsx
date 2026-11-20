import { ArrowRight, MailPlus } from "lucide-react"
import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"

import { AuthShell } from "@/components/shadcn/auth/auth-shell"
import { Button } from "@/components/shadcn/ui/button"

export function RequestInvitePage() {
  const { t } = useTranslation()

  return (
    <AuthShell contentClassName="max-w-md">
      <div className="flex flex-col items-center gap-5 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MailPlus className="size-6" aria-hidden="true" />
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {t("auth.requestInvite.title")}
          </h1>
          <p className="text-sm text-balance text-muted-foreground">
            {t("auth.requestInvite.body")}
          </p>
        </div>

        <div className="flex w-full flex-col gap-2">
          <Button asChild className="h-11 w-full font-semibold">
            <Link to="/login" replace>
              {t("auth.requestInvite.goToLogin")}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild variant="outline" className="h-11 w-full font-semibold">
            <Link to="/landing" replace>
              {t("auth.requestInvite.backToSite")}
            </Link>
          </Button>
        </div>
      </div>
    </AuthShell>
  )
}
