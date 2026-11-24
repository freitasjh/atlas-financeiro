/**
 * Formatação da borda do painel interno (REQ-35).
 *
 * Dinheiro chega em **cents** (BIGINT) e só é formatado aqui — nenhuma
 * aritmética monetária no cliente. Toda saída é texto para célula com
 * `tabular-nums` no componente.
 */

import { formatCentsBRL } from "@/lib/utils"

const EM_DASH = "—"

/** Moeda BRL a partir de cents. Entrada inválida vira travessão, nunca NaN. */
export function formatCurrency(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return EM_DASH
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) return EM_DASH
  return formatCentsBRL(cents)
}

/** `YYYY-MM-DD` (ou ISO completo) → `dd/mm/aaaa`. */
export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return EM_DASH
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (match === null) return EM_DASH
  return `${match[3]}/${match[2]}/${match[1]}`
}

/** Timestamp ISO → `dd/mm/aaaa hh:mm` em America/Sao_Paulo. */
export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return EM_DASH
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return EM_DASH
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(parsed)
}

/** Contagem inteira com separador de milhar pt-BR. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return EM_DASH
  if (!Number.isFinite(value)) return EM_DASH
  return new Intl.NumberFormat("pt-BR").format(Math.trunc(value))
}

/**
 * Documento mascarado: só os 3 últimos dígitos sobrevivem (REQ-15/NFR-04).
 * Documento completo nunca entra no DOM do painel.
 */
export function maskDocument(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "")
  if (digits.length < 4) return EM_DASH
  return `${"•".repeat(digits.length - 3)}${digits.slice(-3)}`
}

/** UUID mascarado: prefixo fixo + 4 últimos caracteres. */
export function maskId(raw: string | null | undefined): string {
  const value = (raw ?? "").trim()
  if (value.length < 4) return EM_DASH
  return `••••${value.slice(-4)}`
}
