/**
 * Contrato de fio dos códigos de recuperação do control plane (ADR-001 §3).
 *
 * Tipos puros + normalização de entrada. Nenhuma credencial em claro atravessa
 * esta camada além da lista devolvida uma única vez por `generate`/`regenerate`.
 */

export const RECOVERY_CONFIRMATION = "REVOGAR_CODIGOS_ATUAIS" as const

export interface RecoveryStatus {
  total: number
  remaining: number
  low: boolean
  codes: readonly { id: string; used_at: string | null }[]
}

export interface RecoveryCodesList {
  set_id: string
  codes: readonly string[]
}

export type RecoveryConsumeOutcome =
  | { ok: true; remaining: number }
  | {
      ok: false
      error: string
      attempts_remaining?: number
      retry_after_seconds?: number
    }

/** Mesma normalização da RPC: lower, sem hífens e sem whitespace. */
export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, "")
}

/** Exibição agrupada `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx` (ADR §3.1). */
export function formatRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code)
  const groups = normalized.match(/.{1,4}/g)
  return groups === null ? "" : groups.join("-")
}

/** `.txt` com cabeçalho + 10 linhas; sem metadados do operador. */
export function recoveryCodesToTxt(codes: readonly string[], header: string): string {
  return `${header}\n\n${codes.map(formatRecoveryCode).join("\n")}\n`
}
