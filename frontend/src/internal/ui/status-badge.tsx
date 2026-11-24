/**
 * Status nunca é só cor (UX §36/REQ-55): ícone + texto + tokens semânticos.
 *
 * Os rótulos são os valores reais do banco (`0055`/`0056`) — nada inventado e
 * nenhuma taxonomia comercial.
 */

import { AlertTriangle, CheckCircle2, Clock, MinusCircle, XCircle } from "lucide-react"
import { useInternalT } from "./use-internal-t"

type Tone = "positive" | "attention" | "negative" | "neutral"

const TONE_CLASS: Record<Tone, string> = {
  positive: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  attention: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  negative: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  neutral: "border-primary/30 bg-primary/10 text-primary",
}

const STATUS_TONE: Record<string, Tone> = {
  active: "positive",
  paid: "positive",
  trial: "neutral",
  open: "neutral",
  past_due: "attention",
  overdue: "attention",
  canceled: "negative",
  refunded: "negative",
}

function StatusIcon({ tone }: { tone: Tone }) {
  if (tone === "positive") return <CheckCircle2 className="size-3" aria-hidden="true" />
  if (tone === "attention") return <Clock className="size-3" aria-hidden="true" />
  if (tone === "negative") return <XCircle className="size-3" aria-hidden="true" />
  return <MinusCircle className="size-3" aria-hidden="true" />
}

export function InternalStatusBadge({ status }: { status: string }) {
  const t = useInternalT()
  const tone = STATUS_TONE[status] ?? "neutral"
  const key = `internalAdmin.status.${status}`
  const translated = t(key)
  const label = translated === key ? status : translated

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASS[tone]}`}
    >
      <StatusIcon tone={tone} />
      {label}
    </span>
  )
}

/** Sinal de alerta em banner (também nunca só cor). */
export function InternalBanner({
  tone,
  title,
  children,
}: {
  tone: "attention" | "negative"
  title: string
  children?: React.ReactNode
}) {
  const toneClass =
    tone === "negative"
      ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400"
      : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
  return (
    <div role="status" className={`flex flex-col gap-1 rounded-xl border p-3 ${toneClass}`}>
      <div className="flex items-center gap-2 text-sm font-semibold">
        {tone === "negative" ? (
          <XCircle className="size-4" aria-hidden="true" />
        ) : (
          <AlertTriangle className="size-4" aria-hidden="true" />
        )}
        {title}
      </div>
      {children !== undefined ? (
        <div className="text-xs text-muted-foreground">{children}</div>
      ) : null}
    </div>
  )
}
