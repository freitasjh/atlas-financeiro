import { formatCentsCompact, type DashboardLocale } from "./format"

function safeTickNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Eixo G1: Recharts pode gerar ticks fracionários; arredondar antes do BigInt. */
export function formatAxisCents(value: unknown, locale: DashboardLocale): string {
  return formatCentsCompact(Math.round(safeTickNumber(value)), locale)
}

/** Eixo G2: compacto sem prefixo de moeda — evita colisão em 375/1280. */
export function formatAxisNumber(value: unknown, locale: DashboardLocale): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Math.round(safeTickNumber(value)))
}
