import * as React from "react"
import { Loader2 } from "lucide-react"
import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"

import { supabase } from "@/lib/supabase"

import { Button } from "@/components/shadcn/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/shadcn/ui/field"
import { Input } from "@/components/shadcn/ui/input"

interface ForgotPasswordFormProps {
  className?: string
}

export function ForgotPasswordForm({ className }: ForgotPasswordFormProps) {
  const { t } = useTranslation()
  const [sent, setSent] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)

  const schema = React.useMemo(
    () =>
      z.object({
        email: z
          .string()
          .min(1, t("auth.forgot.errors.empty"))
          .email(t("auth.forgot.errors.invalid")),
      }),
    [t],
  )

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<{ email: string }>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
    mode: "onBlur",
  })

  const onSubmit = async (values: { email: string }) => {
    setServerError(null)
    const redirectTo = typeof window === "undefined" ? undefined : `${window.location.origin}/`
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(values.email, {
        redirectTo,
      })
      if (error) {
        const status = (error as { status?: number }).status
        const message = (error.message ?? "").toLowerCase()
        if (status === 429 || message.includes("rate")) {
          setServerError(t("auth.forgot.errors.rateLimited"))
        } else if (
          message.includes("network") ||
          message.includes("fetch") ||
          message.includes("failed to fetch")
        ) {
          setServerError(t("auth.forgot.errors.network"))
        } else {
          setServerError(t("auth.forgot.errors.generic"))
        }
        return
      }
      // AC-08: e-mail inexistente responde igual — o texto não promete cadastro.
      setSent(true)
    } catch {
      setServerError(t("auth.forgot.errors.network"))
    }
  }

  return (
    <div className={className}>
      {sent ? (
        <div className="flex flex-col gap-4 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {t("auth.forgot.sentTitle")}
          </h1>
          <p className="text-sm text-balance text-muted-foreground">{t("auth.forgot.sentBody")}</p>
          <Link
            to="/login"
            replace
            className="inline-flex min-h-11 items-center justify-center rounded-md text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("auth.forgot.backToLogin")}
          </Link>
        </div>
      ) : (
        <form className="flex flex-col gap-6" onSubmit={handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <div className="flex flex-col items-center gap-1 text-center">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">
                {t("auth.forgot.title")}
              </h1>
              <p className="text-sm text-balance text-muted-foreground">{t("auth.forgot.hint")}</p>
            </div>

            {serverError ? (
              <div
                role="alert"
                aria-live="assertive"
                className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {serverError}
              </div>
            ) : null}

            <Field>
              <FieldLabel htmlFor="recovery-email">{t("auth.forgot.emailLabel")}</FieldLabel>
              <Input
                id="recovery-email"
                type="email"
                autoFocus
                autoComplete="email"
                inputMode="email"
                placeholder={t("auth.emailPlaceholder")}
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? "recovery-email-error" : undefined}
                {...register("email")}
              />
              <FieldError id="recovery-email-error" errors={[errors.email]} />
            </Field>

            <Field>
              <Button type="submit" disabled={isSubmitting} className="h-11 w-full font-semibold">
                {isSubmitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    {t("auth.forgot.sending")}
                  </>
                ) : (
                  t("auth.forgot.submit")
                )}
              </Button>
            </Field>

            <Link
              to="/login"
              replace
              className="inline-flex min-h-11 items-center justify-center rounded-md text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("auth.forgot.backToLogin")}
            </Link>
          </FieldGroup>
        </form>
      )}

      <div className="mt-6 rounded-lg border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground">{t("auth.forgot.contactTitle")}</p>
        <p className="mt-1 leading-relaxed">{t("auth.forgot.contactBody")}</p>
      </div>
    </div>
  )
}
