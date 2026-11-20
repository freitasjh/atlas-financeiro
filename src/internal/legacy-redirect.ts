/**
 * Redirect legado do control plane (REQ-02/REQ-04) — puro, total e com data
 * de morte declarada.
 *
 * `#/admin`, `#/admin/*`, `#/backoffice` e `#/backoffice/*` não têm elemento
 * próprio: são `Navigate` para `/internal` preservando `search` e `hash`.
 * Depois de `LEGACY_INTERNAL_REDIRECT_DEATH` as entradas saem do router e os
 * paths caem no 404.
 */

export const LEGACY_INTERNAL_REDIRECT_DEATH = "2026-12-31"
export const LEGACY_INTERNAL_REDIRECT_TARGET = "/internal"

const LEGACY_PREFIXES = ["/admin", "/backoffice"] as const
const DEATH_MS = Date.parse(`${LEGACY_INTERNAL_REDIRECT_DEATH}T23:59:59.999Z`)

export interface LegacyInternalRedirectTarget {
  pathname: string
  search: string
  hash: string
}

/** `/admin` casa; `/administrador` e `/backofficex` não. */
export function isLegacyInternalPath(pathname: unknown): boolean {
  if (typeof pathname !== "string") return false
  return LEGACY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

/** A data declarada é inclusiva: só expira depois de 2026-12-31. */
export function isLegacyInternalRedirectExpired(now: Date = new Date()): boolean {
  return now.getTime() > DEATH_MS
}

function normalizePrefix(value: unknown, prefix: "?" | "#"): string {
  if (typeof value !== "string" || value.length === 0) return ""
  return value.startsWith(prefix) ? value : `${prefix}${value}`
}

/**
 * Devolve o destino preservando query/hash ou `null` quando o path não é
 * legado, a data de morte passou ou a entrada é inválida. Nunca lança.
 */
export function resolveLegacyInternalRedirect(
  pathname: unknown,
  search: unknown = "",
  hash: unknown = "",
  now: Date = new Date(),
): LegacyInternalRedirectTarget | null {
  if (!isLegacyInternalPath(pathname)) return null
  if (isLegacyInternalRedirectExpired(now)) return null
  return {
    pathname: LEGACY_INTERNAL_REDIRECT_TARGET,
    search: normalizePrefix(search, "?"),
    hash: normalizePrefix(hash, "#"),
  }
}
