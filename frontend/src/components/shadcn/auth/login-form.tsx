import * as React from "react"
import { Loader2 } from "lucide-react"
import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"

import { cn } from "@/lib/cn"
import { supabase } from "@/lib/supabase"

import { Button } from "@/components/shadcn/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/shadcn/ui/field"
import { Input } from "@/components/shadcn/ui/input"

function signInShape(emailMessage: string, passwordMessage: string) {
  return z.object({
    email: z.string().email(emailMessage),
    password: z.string().min(6, passwordMessage),
  })
}

export const signInSchema = signInShape(
  "Informe um e-mail válido.",
  "A senha deve ter pelo menos 6 caracteres.",
)

export type SignInValues = z.infer<typeof signInSchema>

export interface LoginFormProps extends React.ComponentProps<"form"> {
  /** Hash de destino pós-login (ex.: `#/contas`). Default `#/`. */
  redirectTo?: string
  onSuccess?: () => void
  /** Habilita o atalho "Esqueci minha senha" ao lado do label. */
  forgotPasswordHref?: string
}

export function LoginForm({
  className,
  redirectTo,
  onSuccess,
  forgotPasswordHref,
  ...props
}: LoginFormProps) {
  const { t } = useTranslation()
  const [showPassword, setShowPassword] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const [capsLock, setCapsLock] = React.useState(false)

  const schema = React.useMemo(
    () =>
      signInShape(
        t("auth.errors.invalidEmail"),
        t("auth.errors.shortPassword"),
      ),
    [t],
  )

  const form = useForm<SignInValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
    mode: "onBlur",
  })

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    resetField,
    setFocus,
  } = form

  const onSubmit = async (values: SignInValues) => {
    setServerError(null)
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: values.email,
        password: values.password,
      })

      if (error) {
        const status = (error as { status?: number }).status
        const message = (error.message ?? "").toLowerCase()
        let msg = t("auth.invalidCredentials")
        if (status === 429 || message.includes("rate")) {
          msg = t("auth.tooManyAttempts")
        } else if (
          message.includes("network") ||
          message.includes("fetch") ||
          message.includes("failed to fetch")
        ) {
          msg = t("auth.networkError")
        } else if (
          message.includes("invalid") ||
          status === 400 ||
          status === 401
        ) {
          msg = t("auth.invalidCredentials")
        }
        setServerError(msg)
        resetField("password")
        window.setTimeout(() => setFocus("password"), 0)
        return
      }

      toast.success(t("auth.welcomeBack"), {
        description: t("auth.welcomeBackDescription"),
      })
      if (onSuccess) onSuccess()
      window.location.hash = redirectTo ?? "#/"
    } catch {
      setServerError(t("auth.networkError"))
      resetField("password")
      window.setTimeout(() => setFocus("password"), 0)
    }
  }

  const handleCapsLock = (event: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(event.getModifierState("CapsLock"))
  }

  return (
    <form
      className={cn("flex flex-col gap-6", className)}
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      {...props}
    >
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {t("auth.loginHeading")}
          </h1>
          <p className="text-sm text-balance text-muted-foreground">
            {t("auth.loginSubtitle")}
          </p>
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
          <FieldLabel htmlFor="email">{t("auth.email")}</FieldLabel>
          <Input
            id="email"
            type="email"
            placeholder={t("auth.emailPlaceholder")}
            autoComplete="email"
            inputMode="email"
            className="h-11 sm:h-10"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            {...register("email")}
          />
          <FieldError id="email-error" errors={[errors.email]} />
        </Field>

        <Field>
          <div className="flex items-center justify-between gap-3">
            <FieldLabel htmlFor="password">{t("auth.password")}</FieldLabel>
            {forgotPasswordHref ? (
              <Link
                to={forgotPasswordHref}
                replace
                className="inline-flex min-h-11 items-center rounded-md text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("auth.forgot.linkLabel")}
              </Link>
            ) : null}
          </div>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              className="h-11 sm:h-10"
              aria-invalid={!!errors.password}
              aria-describedby={
                errors.password
                  ? "password-error"
                  : capsLock
                    ? "caps-hint"
                    : undefined
              }
              onKeyDown={handleCapsLock}
              onKeyUp={handleCapsLock}
              {...register("password")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
              className="absolute right-2 top-1/2 -translate-y-1/2 min-h-11 min-w-11 rounded px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showPassword ? t("auth.hide") : t("auth.show")}
            </button>
          </div>
          <FieldError id="password-error" errors={[errors.password]} />
          {capsLock ? (
            <p
              id="caps-hint"
              aria-live="polite"
              className="text-xs text-muted-foreground"
            >
              {t("auth.capsLockOn")}
            </p>
          ) : null}
        </Field>

        <Field>
          <Button
            type="submit"
            disabled={isSubmitting}
            className="w-full h-11 font-semibold"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {t("auth.signingIn")}
              </>
            ) : (
              t("auth.signIn")
            )}
          </Button>
        </Field>

        <p className="text-center text-xs text-muted-foreground">
          {t("auth.secureFooter")}
        </p>
      </FieldGroup>
    </form>
  )
}
