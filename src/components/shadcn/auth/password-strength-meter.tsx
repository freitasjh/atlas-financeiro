import { useTranslation } from "react-i18next"

import { cn } from "@/lib/cn"

export type PasswordStrengthLevel = 0 | 1 | 2 | 3 | 4

/**
 * Heurística sem dependência externa: comprimento + variedade de classes.
 * Retorna 0 (vazio) ou 1..4 (Fraca/Razoável/Boa/Forte). A UI só reflete o
 * mínimo de 6 caracteres da config do Supabase — não endurece a regra.
 */
export function passwordStrengthScore(password: string): PasswordStrengthLevel {
  if (!password) return 0
  let score = 0
  if (password.length >= 6) score += 1
  if (password.length >= 10) score += 1
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1
  return Math.min(4, Math.max(1, score)) as PasswordStrengthLevel
}

const SEGMENT_TONES: Record<Exclude<PasswordStrengthLevel, 0>, string> = {
  1: "bg-destructive",
  2: "bg-amber-500",
  3: "bg-emerald-500",
  4: "bg-emerald-500",
}

const LABEL_TONES: Record<Exclude<PasswordStrengthLevel, 0>, string> = {
  1: "text-destructive",
  2: "text-amber-600 dark:text-amber-400",
  3: "text-emerald-600 dark:text-emerald-400",
  4: "text-emerald-600 dark:text-emerald-400",
}

const LABEL_KEYS: Record<Exclude<PasswordStrengthLevel, 0>, string> = {
  1: "auth.setPassword.strength.weak",
  2: "auth.setPassword.strength.fair",
  3: "auth.setPassword.strength.good",
  4: "auth.setPassword.strength.strong",
}

export interface PasswordStrengthMeterProps {
  password: string
  className?: string
}

export function PasswordStrengthMeter({ password, className }: PasswordStrengthMeterProps) {
  const { t } = useTranslation()
  const score = passwordStrengthScore(password)
  const visibleLabel = score === 0 ? "" : t(LABEL_KEYS[score])

  return (
    <div data-testid="password-strength" className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex gap-1" aria-hidden="true">
        {([1, 2, 3, 4] as const).map((level) => (
          <span
            key={level}
            data-strength-segment
            data-filled={score >= level ? "true" : "false"}
            className={cn(
              "h-1.5 flex-1 rounded-full transition-colors motion-reduce:transition-none",
              score >= level ? SEGMENT_TONES[score as Exclude<PasswordStrengthLevel, 0>] : "bg-muted",
            )}
          />
        ))}
      </div>
      <p
        data-strength-label
        data-level={score}
        aria-live="polite"
        className={cn(
          "min-h-4 text-xs font-medium",
          score === 0 ? "text-muted-foreground" : LABEL_TONES[score],
        )}
      >
        {score === 0 ? null : (
          <>
            <span className="sr-only">{t("auth.setPassword.strength.prefix")}</span>
            {visibleLabel}
          </>
        )}
      </p>
    </div>
  )
}
