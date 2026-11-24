export type DashboardLocale = "pt-BR" | "en-US"

/** i18next pode devolver `en` / `pt-BR`; o formatador só aceita os dois locais do catálogo. */
export function resolveDashboardLocale(language: string | undefined): DashboardLocale {
  return language?.toLowerCase().startsWith("en") ? "en-US" : "pt-BR"
}

const CURRENCY = "BRL"

function toBigInt(cents: bigint | number): bigint {
  if (cents === null || cents === undefined) {
    throw new TypeError("dashboard: valor monetário não pode ser nulo")
  }
  if (typeof cents === "bigint") return cents
  if (typeof cents === "number") {
    if (!Number.isSafeInteger(cents)) {
      throw new RangeError("dashboard: cêntimos devem ser inteiros seguros")
    }
    return BigInt(cents)
  }
  throw new TypeError("dashboard: cêntimos devem ser bigint ou inteiro")
}

const prefixCache = new Map<DashboardLocale, { prefix: string; decimal: string }>()

function currencyMarks(locale: DashboardLocale) {
  const cached = prefixCache.get(locale)
  if (cached) return cached

  const parts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: CURRENCY,
  }).formatToParts(0)
  let prefix = ""
  let decimal = ","
  for (const part of parts) {
    if (part.type === "currency" || part.type === "literal") prefix += part.value
    if (part.type === "decimal") decimal = part.value
  }
  const marks = {
    // Intl pt-BR usa NBSP depois de "R$"; normalizar para espaço comum evita
    // divergência entre ambientes e mantém a saída legível em tabular-nums.
    prefix: prefix.replace(/[\u00a0\u202f]/g, " "),
    decimal,
  }
  prefixCache.set(locale, marks)
  return marks
}

/**
 * RN01/RF-17: cêntimos inteiros viram texto SÓ aqui.
 *
 * A divisão por 100 é feita com aritmética BigInt; `Intl.NumberFormat` só
 * recebe o inteiro já separado (parte inteira) e os marcadores de moeda do
 * locale. Nenhuma conversão para ponto flutuante — sem notação científica.
 */
export function formatCents(cents: bigint | number, locale: DashboardLocale = "pt-BR"): string {
  const value = toBigInt(cents)
  const negative = value < 0n
  const absolute = negative ? -value : value
  const whole = absolute / 100n
  const fraction = absolute % 100n

  const grouped = new Intl.NumberFormat(locale, {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(whole)
  const { prefix, decimal } = currencyMarks(locale)

  return `${negative ? "-" : ""}${prefix}${grouped}${decimal}${String(fraction).padStart(2, "0")}`
}

/** Rótulo curto para eixos: usa Intl compacta sobre a parte inteira (bigint). */
export function formatCentsCompact(cents: bigint | number, locale: DashboardLocale = "pt-BR"): string {
  const value = toBigInt(cents)
  const negative = value < 0n
  const absolute = negative ? -value : value
  const { prefix } = currencyMarks(locale)
  const grouped = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(absolute / 100n)
  return `${negative ? "-" : ""}${prefix}${grouped}`
}
