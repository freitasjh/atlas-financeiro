import { useId } from "react"
import { cn } from "@/lib/cn"

export interface EsticaGranaMarkProps {
  className?: string
  /** `brand` usa o gradiente esmeralda-teal oficial; `mono` herda currentColor. */
  variant?: "brand" | "mono"
}

/**
 * Símbolo vetorial oficial do Estica Grana.
 * Monograma geométrico "E" com traço central elástico ascendente (expansão e rendimento),
 * desenhado em grid 32×32 para nitidez de 16px (favicon) até formatos hero.
 */
export function EsticaGranaMark({ className, variant = "brand" }: EsticaGranaMarkProps) {
  const gradId = useId()

  if (variant === "mono") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
        className={cn("size-7 shrink-0", className)}
      >
        <path
          d="M8.5 10H15.5M8.5 10V22H20.5M8.5 16H14.5L22.5 9.5M18.5 9.5H22.5V13.5"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={cn("size-7 shrink-0", className)}
    >
      <rect width="32" height="32" rx="8" fill={`url(#${gradId})`} />
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7.5"
        stroke="white"
        strokeOpacity="0.16"
      />
      <path
        d="M8.5 10H15.5M8.5 10V22H20.5M8.5 16H14.5L22.5 9.5M18.5 9.5H22.5V13.5"
        stroke="white"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <defs>
        <linearGradient
          id={gradId}
          x1="2"
          y1="30"
          x2="30"
          y2="2"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#047857" />
          <stop offset="0.55" stopColor="#059669" />
          <stop offset="1" stopColor="#14B8A6" />
        </linearGradient>
      </defs>
    </svg>
  )
}

export interface EsticaGranaLogoProps {
  className?: string
  markClassName?: string
  size?: "sm" | "md" | "lg"
  subtitle?: string
  showWordmark?: boolean
}

const SIZE_MAP = {
  sm: {
    mark: "size-6",
    text: "text-sm",
    gap: "gap-2",
  },
  md: {
    mark: "size-8",
    text: "text-base sm:text-lg",
    gap: "gap-2.5",
  },
  lg: {
    mark: "size-9",
    text: "text-lg sm:text-xl",
    gap: "gap-3",
  },
} as const

/**
 * Assinatura visual completa (símbolo + wordmark) do Estica Grana.
 */
export function EsticaGranaLogo({
  className,
  markClassName,
  size = "md",
  subtitle,
  showWordmark = true,
}: EsticaGranaLogoProps) {
  const tokens = SIZE_MAP[size]

  return (
    <span className={cn("inline-flex min-w-0 items-center", tokens.gap, className)}>
      <EsticaGranaMark className={cn(tokens.mark, "shadow-xs rounded-lg", markClassName)} />
      {showWordmark ? (
        <span className="flex min-w-0 flex-col leading-none">
          <span className={cn("truncate font-extrabold tracking-tight text-foreground", tokens.text)}>
            Estica{" "}
            <span className="text-emerald-600 dark:text-emerald-400">Grana</span>
          </span>
          {subtitle ? (
            <span className="mt-0.5 truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}
