import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react"
import { CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react"
import { Link, useLocation } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { Controller, useForm } from "react-hook-form"
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
  FieldLegend,
  FieldSet,
} from "@/components/shadcn/ui/field"
import { Input } from "@/components/shadcn/ui/input"
import { PasswordStrengthMeter } from "@/components/shadcn/auth/password-strength-meter"

/** DVs idênticos a `private.cpf_dv_ok` / `private.cnpj_dv_ok` (0022_tenants.sql). */
export function cpfDvOk(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false
  const sum = (length: number) =>
    [...value.slice(0, length)].reduce((total, digit, index) => total + Number(digit) * (length + 1 - index), 0)
  let rest = sum(9) % 11
  let dv = rest < 2 ? 0 : 11 - rest
  if (dv !== Number(value[9])) return false
  rest = sum(10) % 11
  dv = rest < 2 ? 0 : 11 - rest
  return dv === Number(value[10])
}

export function cnpjDvOk(value: string): boolean {
  if (!/^\d{14}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false
  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const sum = (weights: number[]) => weights.reduce((total, weight, index) => total + weight * Number(value[index]), 0)
  let rest = sum(weights1) % 11
  let dv = rest < 2 ? 0 : 11 - rest
  if (dv !== Number(value[12])) return false
  rest = sum(weights2) % 11
  dv = rest < 2 ? 0 : 11 - rest
  return dv === Number(value[13])
}

export function maskDocument(digits: string, kind: "pf" | "pj"): string {
  const clean = digits.replace(/\D/g, "").slice(0, kind === "pf" ? 11 : 14)
  if (kind === "pf") {
    if (clean.length <= 3) return clean
    if (clean.length <= 6) return `${clean.slice(0, 3)}.${clean.slice(3)}`
    if (clean.length <= 9) return `${clean.slice(0, 3)}.${clean.slice(3, 6)}.${clean.slice(6)}`
    return `${clean.slice(0, 3)}.${clean.slice(3, 6)}.${clean.slice(6, 9)}-${clean.slice(9)}`
  }
  if (clean.length <= 2) return clean
  if (clean.length <= 5) return `${clean.slice(0, 2)}.${clean.slice(2)}`
  if (clean.length <= 8) return `${clean.slice(0, 2)}.${clean.slice(2, 5)}.${clean.slice(5)}`
  if (clean.length <= 12) return `${clean.slice(0, 2)}.${clean.slice(2, 5)}.${clean.slice(5, 8)}/${clean.slice(8)}`
  return `${clean.slice(0, 2)}.${clean.slice(2, 5)}.${clean.slice(5, 8)}/${clean.slice(8, 12)}-${clean.slice(12)}`
}

export function parseRetryAfterSeconds(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw.trim())) return null
  const seconds = Number(raw.trim())
  return Number.isSafeInteger(seconds) ? Math.min(300, seconds) : null
}

export interface SignupPayload {
  email: string
  password: string
  kind: "pf" | "pj"
  document: string
  razaoSocial: string
  nomeFantasia: string | null
  phone: string | null
  cep: string | null
  logradouro: string | null
  numero: string | null
  complemento: string | null
  bairro: string | null
  cidade: string | null
  uf: string | null
  plano: string | null
}

export interface SignupResult {
  status: number
  retryAfterSeconds: number | null
}

const DEFAULT_RETRY_SECONDS = 60

/**
 * Único cliente da Edge `signup-public`. Nenhum detalhe da resposta de erro
 * (corpo, identificadores, mensagem interna) sai daqui: só status + Retry-After.
 */
export async function postPublicSignup(payload: SignupPayload): Promise<SignupResult> {
  try {
    const { error, response } = await supabase.functions.invoke("signup-public", { body: payload })
    const context = (error as { context?: { status?: number; headers?: Headers } } | null)?.context
    const status = response?.status ?? context?.status ?? (error ? 0 : 201)
    if (!error) return { status: 201, retryAfterSeconds: null }
    const headers = response?.headers ?? context?.headers
    const raw = status === 429 ? headers?.get("Retry-After") ?? null : null
    return { status, retryAfterSeconds: parseRetryAfterSeconds(raw) }
  } catch {
    return { status: 0, retryAfterSeconds: null }
  }
}

type Status = "idle" | "submitting" | "invalid" | "rate-limited" | "failure" | "success"

interface FormValues {
  kind: "pf" | "pj"
  name: string
  email: string
  document: string
  password: string
  accept: boolean
}

export interface SignupFormProps {
  /** Intenção da landing (`?plano=`). Nunca vira promessa de plano pago. */
  plano?: string | null
  /** Injetável para stories/testes; produção usa `postPublicSignup`. */
  submit?: (payload: SignupPayload) => Promise<SignupResult>
  className?: string
}

const byteLength = (value: string) => new TextEncoder().encode(value).length

function signupSchema(messages: {
  email: string
  name: string
  document: string
  password: string
  accept: string
}) {
  return z
    .object({
      kind: z.enum(["pf", "pj"]),
      name: z.string().trim().min(1, messages.name),
      email: z.string().email(messages.email),
      document: z.string(),
      password: z.string(),
      accept: z.boolean(),
    })
    .superRefine((values, ctx) => {
      const valid = values.kind === "pf" ? cpfDvOk(values.document) : cnpjDvOk(values.document)
      if (!valid) {
        ctx.addIssue({ code: "custom", path: ["document"], message: messages.document })
      }
      const bytes = byteLength(values.password)
      if (bytes < 8 || bytes > 72) {
        ctx.addIssue({ code: "custom", path: ["password"], message: messages.password })
      }
      if (!values.accept) {
        ctx.addIssue({ code: "custom", path: ["accept"], message: messages.accept })
      }
    })
}

export function SignupForm({ plano, submit = postPublicSignup, className }: SignupFormProps) {
  const { t } = useTranslation()
  const location = useLocation()
  const [status, setStatus] = useState<Status>("idle")
  const [seconds, setSeconds] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  const planoIntent = plano ?? new URLSearchParams(location.search).get("plano")
  const search = location.search

  const schema = useMemo(
    () =>
      signupSchema({
        email: t("auth.signup.errors.email"),
        name: t("auth.signup.errors.name"),
        document: t("auth.signup.errors.document"),
        password: t("auth.signup.errors.passwordLength"),
        accept: t("auth.signup.errors.accept"),
      }),
    [t],
  )
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { kind: "pf", name: "", email: "", document: "", password: "", accept: false },
  })
  const {
    control,
    register,
    handleSubmit,
    setValue,
    clearErrors,
    watch,
    formState: { errors, isSubmitting },
  } = form
  const kind = watch("kind")
  const password = watch("password")
  const kindField = register("kind")

  useEffect(() => {
    if (status !== "rate-limited" || seconds === null) return
    if (seconds <= 0) {
      setStatus("idle")
      setSeconds(null)
      setAnnouncement(t("auth.signup.retryReady"))
      return
    }
    const timer = window.setTimeout(() => setSeconds((current) => (current === null ? null : current - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [status, seconds, t])

  const onSubmit = useCallback(
    async (values: FormValues) => {
      setAnnouncement("")
      setStatus("submitting")
      const payload: SignupPayload = {
        email: values.email.trim(),
        password: values.password,
        kind: values.kind,
        document: values.document,
        razaoSocial: values.name.trim(),
        nomeFantasia: null,
        phone: null,
        cep: null,
        logradouro: null,
        numero: null,
        complemento: null,
        bairro: null,
        cidade: null,
        uf: null,
        plano: planoIntent ?? null,
      }
      const result = await submit(payload)
      if (result.status === 201) {
        setStatus("success")
        toast.success(t("auth.signup.successTitle"), { description: t("auth.signup.success") })
        return
      }
      if (result.status === 400) {
        setStatus("invalid")
        window.setTimeout(() => formRef.current?.focus(), 0)
        return
      }
      if (result.status === 429) {
        setSeconds(result.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS)
        setStatus("rate-limited")
        return
      }
      setStatus("failure")
    },
    [planoIntent, submit, t],
  )

  const changeKind = (event: ChangeEvent<HTMLInputElement>) => {
    void kindField.onChange(event)
    setValue("document", "", { shouldValidate: false })
    clearErrors("document")
    setAnnouncement(t("auth.signup.kindChanged"))
    setStatus((current) => (current === "invalid" || current === "failure" ? "idle" : current))
  }

  const busy = status === "submitting" || isSubmitting
  const locked = busy || status === "rate-limited"
  const serverMessage =
    status === "invalid"
      ? t("auth.signup.invalid")
      : status === "rate-limited"
        ? t("auth.signup.rateLimited", { seconds: seconds ?? 0 })
        : status === "failure"
          ? t("auth.signup.failure")
          : null

  if (status === "success") {
    return (
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 py-4 text-center">
        <CheckCircle2 className="size-10 text-primary" aria-hidden="true" />
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          {t("auth.signup.successTitle")}
        </h2>
        <p className="text-sm text-balance text-muted-foreground">{t("auth.signup.success")}</p>
        <Button asChild variant="ghost" className="min-h-11 w-full font-semibold">
          <Link to={{ pathname: "/login", search }}>{t("auth.signup.loginLink")}</Link>
        </Button>
      </div>
    )
  }

  return (
    <form
      ref={formRef}
      tabIndex={-1}
      noValidate
      aria-busy={busy}
      onSubmit={handleSubmit(onSubmit)}
      className={cn("flex flex-col gap-4 focus:outline-none", className)}
    >
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <FieldGroup className="gap-4">
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {t("auth.signup.heading")}
          </h1>
          <p className="text-sm text-balance text-muted-foreground">{t("auth.signup.subtitle")}</p>
        </div>

        {serverMessage ? (
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {serverMessage}
          </div>
        ) : null}

        <FieldSet>
          <FieldLegend variant="label">{t("tenant.kindLabel")}</FieldLegend>
          <div className="grid grid-cols-2 gap-2">
            {(["pf", "pj"] as const).map((value) => (
              <label
                key={value}
                className={cn(
                  "flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-md border border-border px-2 text-sm font-medium",
                  "motion-reduce:animate-none",
                  "has-[:checked]:border-primary has-[:checked]:bg-primary/5",
                  "focus-within:outline-none focus-within:ring-2 focus-within:ring-ring",
                )}
              >
                <input
                  {...kindField}
                  type="radio"
                  value={value}
                  checked={kind === value}
                  onChange={changeKind}
                  className="size-4 shrink-0"
                  aria-label={t(value === "pf" ? "tenant.kindPf" : "tenant.kindPj")}
                />
                <span className="min-w-0 text-balance leading-tight">
                  {t(value === "pf" ? "tenant.kindPf" : "tenant.kindPj")}
                </span>
              </label>
            ))}
          </div>
        </FieldSet>

        <Field>
          <FieldLabel htmlFor="signup-name">
            {t(kind === "pf" ? "tenant.fullName" : "tenant.razaoSocial")}
          </FieldLabel>
          <Input
            id="signup-name"
            autoComplete="name"
            className="h-11 w-full min-w-0"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "signup-name-error" : undefined}
            {...register("name")}
          />
          <FieldError id="signup-name-error" errors={[errors.name]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="signup-email">{t("auth.email")}</FieldLabel>
          <Input
            id="signup-email"
            type="email"
            autoFocus
            autoComplete="email"
            inputMode="email"
            placeholder={t("auth.emailPlaceholder")}
            className="h-11 w-full min-w-0"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "signup-email-error" : undefined}
            {...register("email")}
          />
          <FieldError id="signup-email-error" errors={[errors.email]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="signup-document">
            {t(kind === "pf" ? "tenant.documentCpf" : "tenant.documentCnpj")}
          </FieldLabel>
          <Controller
            control={control}
            name="document"
            render={({ field }) => (
              <Input
                id="signup-document"
                ref={field.ref}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={maskDocument(field.value, kind)}
                onBlur={field.onBlur}
                onChange={(event) => field.onChange(event.target.value.replace(/\D/g, "").slice(0, kind === "pf" ? 11 : 14))}
                className="h-11 w-full min-w-0 font-mono tabular-nums"
                aria-invalid={!!errors.document}
                aria-describedby={errors.document ? "signup-document-error" : undefined}
              />
            )}
          />
          <FieldError id="signup-document-error" errors={[errors.document]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="signup-password">{t("auth.password")}</FieldLabel>
          <div className="relative min-w-0">
            <Input
              id="signup-password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              className="h-11 w-full min-w-0 pr-12"
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? "signup-password-error" : undefined}
              {...register("password")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((current) => !current)}
              aria-label={t(showPassword ? "auth.hidePassword" : "auth.showPassword")}
              aria-pressed={showPassword}
              className={cn(
                "absolute right-2 top-1/2 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-md",
                "text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              {showPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{t("auth.signup.passwordHint")}</p>
          <PasswordStrengthMeter password={password ?? ""} />
          <FieldError id="signup-password-error" errors={[errors.password]} />
        </Field>

        <Field>
          <div className="flex min-h-11 items-start gap-3">
            <input
              id="signup-accept"
              type="checkbox"
              className="mt-0.5 size-5 min-h-5 min-w-5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-invalid={!!errors.accept}
              aria-describedby={errors.accept ? "signup-accept-error" : undefined}
              {...register("accept")}
            />
            <FieldLabel htmlFor="signup-accept" className="min-w-0 cursor-pointer leading-snug">
              {t("tenant.acceptTerms", {
                version: t("auth.signup.termsVersion").replace(/^termos-/, ""),
              })}
            </FieldLabel>
          </div>
          <FieldError id="signup-accept-error" errors={[errors.accept]} />
        </Field>

        <Button type="submit" disabled={locked} className="h-11 w-full font-semibold">
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              {t("auth.signup.submitting")}
            </>
          ) : status === "failure" ? (
            t("tenant.retry")
          ) : (
            t("tenant.submit")
          )}
        </Button>

        <div className="flex w-full min-w-0 flex-col gap-1">
          <Button asChild variant="ghost" className="min-h-11 w-full font-medium">
            <Link to={{ pathname: "/login", search }}>{t("auth.signup.loginLink")}</Link>
          </Button>
          <Button asChild variant="ghost" className="min-h-11 w-full font-medium">
            <Link to={{ pathname: "/solicitar-convite", search }}>{t("auth.signup.inviteLink")}</Link>
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}
