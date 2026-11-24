/**
 * Resolve o destino pós-login a partir de `location.state.from`.
 * Aceita apenas caminho interno (inicia com `/`, sem protocol-relative nem
 * quebra de linha) — caso contrário cai no default `#/`.
 */
export function resolveLoginRedirect(from: unknown, fallback = "#/"): string {
  if (typeof from !== "string") return fallback
  const trimmed = from.trim()
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return fallback
  if (/[\r\n]/.test(trimmed)) return fallback
  return `#${trimmed}`
}
